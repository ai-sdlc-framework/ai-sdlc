#!/usr/bin/env node
/**
 * codex-spawn-agent-bridge.mjs — canonical CODEX_SPAWN_AGENT_BIN bridge
 * for `ai-sdlc-pipeline execute --spawner codex` (AISDLC-251).
 *
 * ## Wire protocol
 *
 * The adapter in `pipeline-cli/src/runtime/spawners/codex-harness.ts`
 * (`subprocessCodexSpawnAgent`) spawns this script with no positional args and
 * communicates over stdin/stdout:
 *
 *   1. The adapter writes a single JSON line to stdin:
 *        { agentType, systemPrompt, userPrompt, cwd, timeoutMs }
 *   2. This bridge reads that line, invokes `codex exec` with the correct
 *      flags (see below), captures output, and writes a single JSON line to
 *      stdout:
 *        { output: string, parsed?: unknown }
 *   3. This bridge exits 0 on success; non-zero exits surface stderr as the
 *      SubagentResult error field.
 *
 * ## Verified flag set (AISDLC-249/247 smoke test — codex-cli 0.128.0)
 *
 * Use: `codex exec -s read-only --skip-git-repo-check --color never`
 *
 * DO NOT use `--quiet` (errors with "unexpected argument" on codex 0.128.0).
 * DO NOT use `--model o4-mini` (HTTP 400 on ChatGPT-account auth).
 *
 * The prompt is written to a temp file and passed via `--file` so that long
 * system/user prompts are not mangled by shell argument length limits.
 *
 * ## Per-field overrides
 *
 * The request envelope's optional fields are all honoured if present:
 *   - `extraArgs`: array of additional CLI flags inserted after the verified
 *     base flags. Operators can use this to pass `--model <m>` when their
 *     Codex auth supports it without touching the script.
 *
 * ## Usage
 *
 *   export CODEX_SPAWN_AGENT_BIN="$(pwd)/scripts/codex-spawn-agent-bridge.mjs"
 *   node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs execute AISDLC-NNN --run --spawner codex
 *
 * Run with: node scripts/codex-spawn-agent-bridge.mjs  (reads stdin, writes stdout)
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Reads all of stdin and resolves with the complete string. */
function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

/**
 * Invoke `codex exec` with the verified flag set and return its stdout.
 *
 * @param {string} promptText - Combined prompt (system + user) to pass.
 * @param {string} cwd - Working directory for the codex process.
 * @param {number} timeoutMs - Process kill timeout in milliseconds.
 * @param {string[]} extraArgs - Additional CLI flags (optional overrides).
 * @returns {Promise<string>} stdout from codex exec.
 */
function runCodexExec(promptText, cwd, timeoutMs, extraArgs = []) {
  return new Promise((resolve, reject) => {
    // Write prompt to a temp file to avoid shell argument limits.
    const tmpDir = mkdtempSync(join(tmpdir(), 'codex-bridge-'));
    const promptFile = join(tmpDir, 'prompt.md');
    writeFileSync(promptFile, promptText, 'utf-8');

    const cleanup = () => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    };

    // Verified flag set from AISDLC-249/247 smoke testing (codex-cli 0.128.0,
    // ChatGPT-account auth). DO NOT add --quiet or --model o4-mini here.
    //
    // SECURITY (AISDLC-251 codex code-reviewer finding): filter extraArgs to
    // reject any flag that would override the read-only sandbox guarantee.
    // The bridge MUST run codex in read-only mode regardless of caller input.
    const SANDBOX_OVERRIDE_FLAGS = new Set([
      '-s',
      '--sandbox',
      '--sandbox-mode',
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
    const safeExtraArgs = [];
    for (let i = 0; i < extraArgs.length; i++) {
      const arg = extraArgs[i];
      const flagPart = typeof arg === 'string' ? arg.split('=')[0] : '';
      if (SANDBOX_OVERRIDE_FLAGS.has(flagPart)) {
        // Skip the flag AND its value (if separated by space). Bare-flag forms
        // like --dangerously-bypass-approvals-and-sandbox have no value.
        if (
          (flagPart === '-s' || flagPart === '--sandbox' || flagPart === '--sandbox-mode') &&
          arg === flagPart
        ) {
          i += 1; // skip the next argv (the sandbox value)
        }
        continue;
      }
      safeExtraArgs.push(arg);
    }

    const baseArgs = [
      'exec',
      '-s',
      'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
      ...safeExtraArgs,
      '--file',
      promptFile,
    ];

    let child;
    try {
      child = spawn('codex', baseArgs, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      cleanup();
      reject(new Error(`failed to spawn codex: ${String(err)}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      fn();
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      settle(() => reject(new Error(`codex exec timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      settle(() => reject(new Error(`codex exec errored: ${String(err)}`)));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        settle(() =>
          reject(new Error(`codex exec exited ${code ?? 'null'}: ${stderr.trim() || 'no stderr'}`)),
        );
        return;
      }
      settle(() => resolve(stdout));
    });
  });
}

/**
 * Best-effort JSON parse. Returns the parsed value or undefined.
 * Tolerates markdown-fenced JSON blocks that Codex agents sometimes emit.
 *
 * @param {string} text
 * @returns {unknown | undefined}
 */
function tryParseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Try to extract JSON from a fenced code block.
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (fenced && fenced[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

async function main() {
  let rawInput;
  try {
    rawInput = await readStdin();
  } catch (err) {
    process.stderr.write(`codex-spawn-agent-bridge: failed to read stdin: ${String(err)}\n`);
    process.exit(1);
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    process.stderr.write('codex-spawn-agent-bridge: empty stdin — expected JSON-line request\n');
    process.exit(1);
  }

  /** @type {{ agentType: string, systemPrompt: string, userPrompt: string, cwd: string, timeoutMs: number, extraArgs?: string[] }} */
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch (err) {
    process.stderr.write(`codex-spawn-agent-bridge: stdin is not valid JSON: ${String(err)}\n`);
    process.exit(1);
  }

  const {
    systemPrompt = '',
    userPrompt = '',
    cwd = process.cwd(),
    timeoutMs = 1800000,
    extraArgs = [],
  } = request;

  // Compose a single prompt string: system context followed by user prompt.
  // `codex exec --file` reads the file as the user message; we prepend the
  // system prompt as a clearly labelled section so the model has full context.
  const promptText = systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt;

  let output;
  try {
    output = await runCodexExec(promptText, cwd, timeoutMs, extraArgs);
  } catch (err) {
    process.stderr.write(`codex-spawn-agent-bridge: ${String(err)}\n`);
    process.exit(1);
  }

  const parsed = tryParseJson(output);

  /** @type {{ output: string, parsed?: unknown }} */
  const response = parsed !== undefined ? { output, parsed } : { output };

  process.stdout.write(JSON.stringify(response) + '\n');
}

main().catch((err) => {
  process.stderr.write(`codex-spawn-agent-bridge: unhandled error: ${String(err)}\n`);
  process.exit(1);
});
