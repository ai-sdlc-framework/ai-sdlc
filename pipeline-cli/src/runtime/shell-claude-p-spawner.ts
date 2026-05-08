/**
 * `ShellClaudePSpawner` — Tier 2 default `SubagentSpawner` (RFC-0012 §8.2).
 *
 * Shells out to the operator's installed `claude` CLI (Claude Code), running
 * one short-lived non-interactive (`--print`) session per `spawn` call. Uses
 * the operator's logged-in subscription auth — no API tokens consumed, the
 * cost lands on the same Claude Code Max-20x plan that backs `/ai-sdlc execute`.
 *
 * ## Q5 resolution (RFC §15) — `--subagent <type>` does NOT exist
 *
 * The RFC's §8.2 sample code sketched a `--subagent <type>` flag. Empirical
 * `claude --help` (verified 2026-04-30 against the operator's installed CLI)
 * shows the actual flag is **`--agent <agent>`** (singular, no "sub" prefix).
 * Per-session agent selection is documented in `claude --help`:
 *
 *   --agent <agent>   Agent for the current session. Overrides the 'agent'
 *                     setting.
 *
 * The plugin ships its `developer`, `code-reviewer`, `test-reviewer`, and
 * `security-reviewer` agents as plugin agents (`ai-sdlc-plugin/agents/*.md`),
 * which Claude Code resolves by name when `--agent <name>` is passed AND the
 * plugin is loaded in the operator's environment. So the spawner passes
 * `--agent <opts.type>` and trusts that the plugin is on the operator's
 * machine — that's the same assumption Tier 1's slash command body makes.
 *
 * ## Other CLI quirks the spawner papers over
 *
 *  - There is **no `--cwd <path>` flag**. We set the child's working
 *    directory via `child_process.spawn`'s `options.cwd`. Same effect.
 *  - We pass **`--output-format json`** (along with `--print`) so the CLI
 *    emits a single JSON envelope on stdout instead of streaming text. That
 *    makes the response easier to parse than free-form prose.
 *  - We pass **`--permission-mode bypassPermissions`** so the subagent isn't
 *    prompted for tool grants — the spawner runs in unattended Tier 2 contexts
 *    where there's no human at the keyboard. The plugin's PreToolUse hook
 *    still enforces the worktree write-fence + ASCII-filename gates.
 *
 * Argv shape (for safety: NO shell expansion, all values passed as separate
 * argv entries):
 *
 *   claude
 *     --print
 *     --output-format json
 *     --permission-mode bypassPermissions
 *     --agent <type>
 *     <prompt>
 *
 * The prompt is the LAST positional argument so even prompts containing
 * spaces, newlines, quotes, etc. are passed verbatim without re-escaping.
 *
 * ## Output parsing
 *
 * `--output-format json` returns a single envelope shaped roughly like:
 *
 *     { "type": "result", "result": "<text>", ... }
 *
 * The spawner records the **entire stdout** as `output` and tries to extract
 * the agent's structured return value from `result` (or, if `result` itself
 * is JSON-shaped, the parsed JSON of that). When neither shape works the
 * `parsed` field stays undefined and the caller falls back to parsing the
 * raw `output` string.
 *
 * @see RFC-0012 §8 (SubagentSpawner abstraction)
 * @see ai-sdlc-plugin/agents/{developer,code-reviewer,test-reviewer,security-reviewer}.md
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  ANTHROPIC_API_ERROR_PATTERNS,
  tailBytes,
  type SpawnOpts,
  type SubagentResult,
  type SubagentSpawner,
  type SubagentType,
  type SubprocessDiagnostics,
} from '../types.js';

/**
 * Subset of `child_process.spawn` we depend on. Tests inject a fake to assert
 * argv shape and script stdout/exit-code behaviour without touching a real
 * `claude` binary.
 */
export type ProcessSpawner = (
  command: string,
  args: readonly string[],
  options: { cwd?: string },
) => ChildProcess;

/** Constructor options for `ShellClaudePSpawner`. */
export interface ShellClaudePSpawnerOptions {
  /** Override the binary name (default: `'claude'`). Useful for tests. */
  binary?: string;
  /**
   * Inject a custom `child_process.spawn` (for tests). Must conform to the
   * standard signature — the spawner only listens to `stdout`/`stderr`/`close`
   * events on the returned ChildProcess.
   */
  spawn?: ProcessSpawner;
  /**
   * Per-spawn timeout in milliseconds (overridable per-call via `SpawnOpts.timeout`).
   * Default: 30 minutes.
   */
  defaultTimeoutMs?: number;
  /**
   * Extra argv to append BEFORE the prompt positional. Example: `['--model', 'opus']`.
   * Useful for tests + advanced use cases (model override, beta flags).
   */
  extraArgs?: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

export class ShellClaudePSpawner implements SubagentSpawner {
  private readonly binary: string;
  private readonly processSpawner: ProcessSpawner;
  private readonly defaultTimeoutMs: number;
  private readonly extraArgs: readonly string[];

  constructor(options: ShellClaudePSpawnerOptions = {}) {
    this.binary = options.binary ?? 'claude';
    // NB: field name is `processSpawner` (NOT `spawn`) to avoid colliding
    // with the SubagentSpawner.spawn method on the prototype — instance
    // fields shadow methods of the same name.
    this.processSpawner = options.spawn ?? (nodeSpawn as ProcessSpawner);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.extraArgs = options.extraArgs ?? [];
  }

  async spawnParallel(opts: SpawnOpts[]): Promise<SubagentResult[]> {
    return Promise.all(opts.map((o) => this.spawn1(o)));
  }

  spawn(opts: SpawnOpts): Promise<SubagentResult> {
    return this.spawn1(opts);
  }

  /**
   * Build the argv list for a given subagent invocation. Exposed (rather than
   * inlined) so tests can assert the exact CLI shape without invoking `spawn`.
   */
  buildArgv(opts: SpawnOpts): string[] {
    return [
      '--print',
      '--output-format',
      'json',
      '--permission-mode',
      'bypassPermissions',
      '--agent',
      opts.type,
      ...this.extraArgs,
      opts.prompt,
    ];
  }

  private spawn1(opts: SpawnOpts): Promise<SubagentResult> {
    const start = Date.now();
    const argv = this.buildArgv(opts);
    const timeoutMs = opts.timeout ?? this.defaultTimeoutMs;

    return new Promise<SubagentResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = this.processSpawner(this.binary, argv, { cwd: opts.cwd });
      } catch (err) {
        const wallClockMs = Date.now() - start;
        const diag: SubprocessDiagnostics = {
          exitCode: null,
          signal: null,
          stderrTail: '',
          wallClockMs,
          argv,
          failureType: 'claude-cli-spawn-error',
        };
        resolve({
          type: opts.type,
          output: '',
          status: 'error',
          error: `failed to spawn ${this.binary}: ${stringifyError(err)}`,
          durationMs: wallClockMs,
          subprocessDiagnostics: diag,
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      let watchdogFired = false;

      const settle = (result: SubagentResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        watchdogFired = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        const wallClockMs = Date.now() - start;
        const diag: SubprocessDiagnostics = {
          exitCode: null,
          signal: 'SIGTERM',
          stderrTail: tailBytes(stderr, 2048),
          wallClockMs,
          argv,
          failureType: 'claude-cli-killed',
          watchdogFired: true,
        };
        settle({
          type: opts.type,
          output: stdout,
          status: 'timeout',
          error: `claude -p timed out after ${timeoutMs}ms`,
          durationMs: wallClockMs,
          subprocessDiagnostics: diag,
        });
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        const wallClockMs = Date.now() - start;
        const diag: SubprocessDiagnostics = {
          exitCode: null,
          signal: null,
          stderrTail: tailBytes(stderr, 2048),
          wallClockMs,
          argv,
          failureType: 'claude-cli-watch-error',
        };
        settle({
          type: opts.type,
          output: stdout,
          status: 'error',
          error: stringifyError(err),
          durationMs: wallClockMs,
          subprocessDiagnostics: diag,
        });
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        const wallClockMs = Date.now() - start;
        const stderrTail = tailBytes(stderr, 2048);

        // Killed by signal
        if (signal !== null) {
          const isWatchableSignal = signal === 'SIGKILL' || signal === 'SIGTERM';
          const diag: SubprocessDiagnostics = {
            exitCode: code,
            signal,
            stderrTail,
            wallClockMs,
            argv,
            ...(isWatchableSignal
              ? { failureType: 'claude-cli-killed', watchdogFired }
              : { failureType: 'claude-cli-killed', watchdogFired }),
          };
          settle({
            type: opts.type,
            output: stdout,
            status: 'error',
            error: `claude -p killed by signal ${signal}`,
            durationMs: wallClockMs,
            subprocessDiagnostics: diag,
          });
          return;
        }

        if (code !== 0) {
          // Classify failure type based on stderr content
          const isApiError = ANTHROPIC_API_ERROR_PATTERNS.some((re) => re.test(stderrTail));
          const failureType = isApiError ? 'claude-cli-api-error' : 'claude-cli-nonzero-exit';
          const diag: SubprocessDiagnostics = {
            exitCode: code,
            signal: null,
            stderrTail,
            wallClockMs,
            argv,
            failureType,
          };
          settle({
            type: opts.type,
            output: stdout,
            status: 'error',
            error: stderrTail.trim() || `claude -p exited with code ${code ?? 'null'}`,
            durationMs: wallClockMs,
            subprocessDiagnostics: diag,
          });
          return;
        }

        // Exit code 0 — check for empty-stdout-fast anomaly
        const EMPTY_OUTPUT_FAST_THRESHOLD_MS = 5000;
        const isEmptyFast =
          stdout.trim().length === 0 && wallClockMs < EMPTY_OUTPUT_FAST_THRESHOLD_MS;
        const diag: SubprocessDiagnostics = {
          exitCode: 0,
          signal: null,
          stderrTail,
          wallClockMs,
          argv,
          ...(isEmptyFast ? { failureType: 'claude-cli-empty-output-fast' } : {}),
        };

        const parsed = parseClaudeOutput(stdout);
        settle({
          type: opts.type,
          output: stdout,
          parsed,
          status: 'success',
          durationMs: wallClockMs,
          subprocessDiagnostics: diag,
        });
      });
    });
  }
}

/**
 * Best-effort parse of the JSON envelope `claude --output-format json` emits.
 *
 * Handles three shapes:
 *
 *  1. `{ "type": "result", "result": "<json-string>", ... }` — the common case
 *     when the subagent returns structured JSON (per its return contract).
 *     We parse `result` as JSON and return that object.
 *  2. `{ "type": "result", "result": <object>, ... }` — when the CLI already
 *     returned `result` as a parsed object.
 *  3. The whole stdout is itself JSON — parse and return as-is.
 *
 * If none of these shape-checks succeed, returns `undefined` so the caller
 * can fall back to parsing the raw `output` string (which is what the
 * `parseDeveloperReturn` step already does for legacy paths).
 */
export function parseClaudeOutput(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  let envelope: unknown;
  try {
    envelope = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (typeof envelope === 'object' && envelope !== null && 'result' in envelope) {
    const result = (envelope as { result: unknown }).result;
    if (typeof result === 'string') {
      try {
        return JSON.parse(result);
      } catch {
        return result;
      }
    }
    return result;
  }
  return envelope;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Re-export the type marker for `SubagentType` so callers building argv lists
// elsewhere (e.g. `defaultSpawner`) don't need a second import.
export type { SubagentType };
