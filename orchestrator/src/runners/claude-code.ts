/**
 * Claude Code runner — invokes Claude Code CLI in --print mode
 * and collects the result via git diff.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AgentRunner,
  AgentContext,
  AgentResult,
  AgentProgressEvent,
  TokenUsage,
} from './types.js';
import {
  DEFAULT_MODEL,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_RUNNER_TIMEOUT_MS,
  DEFAULT_LINT_COMMAND,
  DEFAULT_FORMAT_COMMAND,
  DEFAULT_COMMIT_MESSAGE_TEMPLATE,
  DEFAULT_COMMIT_CO_AUTHOR,
} from '../defaults.js';
import { formatContextForPrompt } from '../analysis/context-builder.js';

const execFileAsync = promisify(execFile);

/**
 * Build verification step instructions (lint, format, typecheck).
 * Returns an array of numbered step strings starting from the given step number.
 */
function buildVerificationSteps(
  startStep: number,
  lintCmd?: string,
  fmtCmd?: string,
  typecheckCmd?: string,
): { lines: string[]; nextStep: number } {
  let step = startStep;
  const lines: string[] = [];

  if (lintCmd && fmtCmd) {
    lines.push(
      `${++step}. After making code changes, run \`${lintCmd}\` and \`${fmtCmd}\` to catch issues before committing.`,
    );
  } else if (lintCmd) {
    lines.push(
      `${++step}. After making code changes, run \`${lintCmd}\` to catch issues before committing.`,
    );
  } else if (fmtCmd) {
    lines.push(
      `${++step}. After making code changes, run \`${fmtCmd}\` to catch issues before committing.`,
    );
  }

  if (typecheckCmd) {
    lines.push(
      `${++step}. IMPORTANT: Run \`${typecheckCmd}\` to verify there are no TypeScript errors. The pre-commit hook will reject your commit if there are type errors. Fix ALL type errors before committing.`,
    );
  }

  return { lines, nextStep: step };
}

export function buildPrompt(ctx: AgentContext): string {
  const lintCmd = ctx.lintCommand ?? DEFAULT_LINT_COMMAND;
  const fmtCmd = ctx.formatCommand ?? DEFAULT_FORMAT_COMMAND;
  const typecheckCmd = ctx.typecheckCommand;

  const lines = [
    `You are fixing issue ${/^\d+$/.test(ctx.issueId) ? '#' : ''}${ctx.issueId}: ${ctx.issueTitle}`,
    '',
    '## Issue Description',
    ctx.issueBody,
    '',
  ];

  if (ctx.ciErrors) {
    let step = 0;
    lines.push(
      '## CI Failure Logs',
      '',
      '```',
      ctx.ciErrors,
      '```',
      '',
      '## Instructions',
      `${++step}. Analyze the CI failure logs above to identify the root cause.`,
      `${++step}. Read the relevant source files to understand the context.`,
      `${++step}. Fix the errors that caused CI to fail.`,
    );
    if (fmtCmd) {
      lines.push(
        `${++step}. If the failure is a formatting/prettier error, run \`${fmtCmd}\` to auto-fix it.`,
      );
    }
    const ciVerify = buildVerificationSteps(step, lintCmd, fmtCmd, typecheckCmd);
    lines.push(...ciVerify.lines);
    step = ciVerify.nextStep;
    lines.push(
      `${++step}. Write or update tests if needed to cover your fix.`,
      `${++step}. NEVER modify files matching the blocked paths below — violations will be automatically detected and the change will be rejected.`,
      `${++step}. Keep your changes to at most ${ctx.constraints.maxFilesPerChange} files.`,
    );
  } else if (ctx.reviewFindings) {
    let step = 0;
    lines.push(
      '## Review Findings',
      '',
      ctx.reviewFindings,
      '',
      '## Instructions',
      `${++step}. Read the review findings above carefully.`,
      `${++step}. Read the relevant source files to understand the context.`,
      `${++step}. Address all the review findings by making necessary code changes.`,
      `${++step}. Write or update tests if requested by the reviewers.`,
    );
    const reviewVerify = buildVerificationSteps(step, lintCmd, fmtCmd, typecheckCmd);
    lines.push(...reviewVerify.lines);
    step = reviewVerify.nextStep;
    lines.push(
      `${++step}. NEVER modify files matching the blocked paths below — violations will be automatically detected and the change will be rejected.`,
      `${++step}. Keep your changes to at most ${ctx.constraints.maxFilesPerChange} files.`,
    );
  } else {
    let step = 0;
    lines.push(
      '## Instructions',
      `${++step}. Read the relevant source files to understand the codebase.`,
      `${++step}. Implement the fix or feature described in the issue.`,
      `${++step}. Write or update tests to cover your changes.`,
    );
    const defaultVerify = buildVerificationSteps(step, lintCmd, fmtCmd, typecheckCmd);
    lines.push(...defaultVerify.lines);
    step = defaultVerify.nextStep;
    lines.push(
      `${++step}. NEVER modify files matching the blocked paths below — violations will be automatically detected and the change will be rejected.`,
      `${++step}. Keep your changes to at most ${ctx.constraints.maxFilesPerChange} files.`,
    );
  }

  lines.push(
    '',
    '## Constraints (enforced — violations will be automatically rejected)',
    `- Maximum files to change: ${ctx.constraints.maxFilesPerChange}`,
    `- Tests required: ${ctx.constraints.requireTests}`,
    `- Blocked paths (NEVER modify — changes will be rejected): ${ctx.constraints.blockedPaths.join(', ') || 'none'}`,
  );

  // Append relevant episodic memory if available
  if (ctx.memory) {
    const episodes = ctx.memory.episodic.search(`issue-${ctx.issueId}`);
    if (episodes.length > 0) {
      lines.push('', '## Previous Context');
      for (const ep of episodes.slice(0, 5)) {
        const summary =
          ep.metadata && typeof ep.metadata === 'object' && 'summary' in ep.metadata
            ? (ep.metadata as Record<string, unknown>).summary
            : ep.key;
        lines.push(`- ${summary}`);
      }
    }
  }

  // Append episodic context if available
  if (ctx.episodicContext) {
    lines.push('', ctx.episodicContext);
  }

  // Append codebase context if available
  if (ctx.codebaseContext) {
    lines.push('', formatContextForPrompt(ctx.codebaseContext));
  }

  return lines.join('\n');
}

async function gitExec(workDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: workDir });
  return stdout.trim();
}

interface RunClaudeOptions {
  allowedTools?: string[];
  timeoutMs?: number;
  model?: string;
  /** When set, spawns claude inside this OpenShell sandbox. */
  sandboxId?: string;
  /** Progress callback for streaming events. */
  onProgress?: (event: AgentProgressEvent) => void;
}

interface RunClaudeResult {
  stdout: string;
  stderr: string;
  model: string;
  costUsd?: number;
}

/**
 * Extract a file path from a tool_use input object.
 */
function extractFilePath(input: Record<string, unknown>): string | undefined {
  return (
    (typeof input.file_path === 'string' ? input.file_path : undefined) ??
    (typeof input.path === 'string' ? input.path : undefined) ??
    (typeof input.pattern === 'string' ? input.pattern : undefined) ??
    (typeof input.command === 'string' ? input.command.slice(0, 80) : undefined)
  );
}

/**
 * Parse a single NDJSON line from Claude Code stream-json output
 * and emit a progress event if applicable.
 */
function parseStreamEvent(
  line: string,
  onProgress: (event: AgentProgressEvent) => void,
): { resultText?: string; costUsd?: number; tokenUsage?: TokenUsage } | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  const type = parsed.type as string;

  if (type === 'assistant') {
    const message = parsed.message as Record<string, unknown> | undefined;
    const content = message?.content as Array<Record<string, unknown>> | undefined;
    if (!content) return undefined;

    for (const block of content) {
      if (block.type === 'tool_use') {
        const toolName = String(block.name ?? '');
        const input = (block.input ?? {}) as Record<string, unknown>;
        const filePath = extractFilePath(input);
        onProgress({
          type: 'tool_start',
          tool: toolName,
          file: filePath,
          message: filePath ? `${toolName}: ${filePath}` : toolName,
        });
      } else if (block.type === 'text') {
        const text = String(block.text ?? '');
        if (text.length > 0) {
          onProgress({
            type: 'text',
            message: text.slice(0, 200),
          });
        }
      }
    }
  }

  if (type === 'result') {
    const resultText = parsed.result as string | undefined;
    const costUsd = parsed.total_cost_usd as number | undefined;

    // Extract token usage from result event
    const modelUsage = parsed.modelUsage as Record<string, Record<string, unknown>> | undefined;
    let tokenUsage: TokenUsage | undefined;
    if (modelUsage) {
      const firstModel = Object.keys(modelUsage)[0];
      if (firstModel) {
        const usage = modelUsage[firstModel];
        tokenUsage = {
          inputTokens: (usage.inputTokens as number) ?? 0,
          outputTokens: (usage.outputTokens as number) ?? 0,
          cacheReadTokens: (usage.cacheReadInputTokens as number) ?? undefined,
          model: firstModel,
        };
      }
    }

    if (costUsd !== undefined) {
      onProgress({ type: 'cost', costUsd, message: `Total cost: $${costUsd.toFixed(4)}` });
    }

    return { resultText: resultText ?? undefined, costUsd, tokenUsage };
  }

  return undefined;
}

function runClaude(
  prompt: string,
  workDir: string,
  opts?: RunClaudeOptions,
): Promise<RunClaudeResult> {
  const tools = opts?.allowedTools?.join(',') ?? DEFAULT_ALLOWED_TOOLS;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const model = opts?.model ?? process.env.AI_SDLC_MODEL ?? DEFAULT_MODEL;
    const claudeArgs = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      model,
      '--allowedTools',
      tools,
    ];

    // When running inside an OpenShell sandbox, prefix with sandbox connect.
    const useOpenShell = opts?.sandboxId && process.env.AI_SDLC_SANDBOX_PROVIDER === 'openshell';
    let cmd: string;
    let args: string[];
    if (useOpenShell) {
      cmd = 'openshell';
      args = ['sandbox', 'connect', opts.sandboxId!, '--', 'claude', ...claudeArgs];
    } else {
      cmd = 'claude';
      args = claudeArgs;
    }

    const startTime = Date.now();
    const logPrefix = `[ai-sdlc:runner]`;
    process.stderr.write(`${logPrefix} spawning: ${cmd} ${args.join(' ')}\n`);
    process.stderr.write(`${logPrefix} workDir: ${workDir}\n`);
    process.stderr.write(`${logPrefix} timeout: ${timeoutMs}ms\n`);

    const child = spawn(cmd, args, {
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      timeout: timeoutMs,
    });

    process.stderr.write(`${logPrefix} pid: ${child.pid}\n`);

    let lastActivity = Date.now();
    let resultText: string | undefined;
    let resultCost: number | undefined;
    let resultTokenUsage: TokenUsage | undefined;

    // Buffer for incomplete NDJSON lines
    let lineBuffer = '';
    const onProgress = opts?.onProgress;

    child.stdout.on('data', (data: Buffer) => {
      lastActivity = Date.now();

      // Parse NDJSON lines from stream-json output
      lineBuffer += data.toString('utf-8');
      const lines = lineBuffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Log raw events to stderr for CI visibility
        process.stderr.write(`${logPrefix} event: ${trimmed.slice(0, 200)}\n`);

        if (onProgress) {
          const result = parseStreamEvent(trimmed, onProgress);
          if (result) {
            if (result.resultText !== undefined) resultText = result.resultText;
            if (result.costUsd !== undefined) resultCost = result.costUsd;
            if (result.tokenUsage) resultTokenUsage = result.tokenUsage;
          }
        } else {
          // Still parse result event even without progress callback
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.type === 'result') {
              resultText = parsed.result as string;
              resultCost = parsed.total_cost_usd as number;
              const modelUsage = parsed.modelUsage as
                | Record<string, Record<string, unknown>>
                | undefined;
              if (modelUsage) {
                const firstModel = Object.keys(modelUsage)[0];
                if (firstModel) {
                  const usage = modelUsage[firstModel];
                  resultTokenUsage = {
                    inputTokens: (usage.inputTokens as number) ?? 0,
                    outputTokens: (usage.outputTokens as number) ?? 0,
                    cacheReadTokens: (usage.cacheReadInputTokens as number) ?? undefined,
                    model: firstModel,
                  };
                }
              }
            }
          } catch {
            // Not JSON — ignore
          }
        }
      }
    });

    const errChunks: Buffer[] = [];
    child.stderr.on('data', (data: Buffer) => {
      errChunks.push(data);
      lastActivity = Date.now();
      process.stderr.write(data);
    });

    // Heartbeat: log progress every 30s so CI knows the process is alive
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const idle = Math.round((Date.now() - lastActivity) / 1000);
      process.stderr.write(`${logPrefix} heartbeat: ${elapsed}s elapsed, ${idle}s idle\n`);
    }, 30_000);

    child.on('close', (code) => {
      clearInterval(heartbeat);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const stderr = Buffer.concat(errChunks).toString('utf-8');
      process.stderr.write(`${logPrefix} exited: code=${code} elapsed=${elapsed}s\n`);
      if (code === 0) {
        resolve({
          stdout: resultText ?? '',
          stderr,
          model: resultTokenUsage?.model ?? model,
          costUsd: resultCost,
        });
      } else {
        reject(new Error(`claude exited with code ${code}: ${stderr || resultText || ''}`));
      }
    });

    child.on('error', (err) => {
      clearInterval(heartbeat);
      process.stderr.write(`${logPrefix} spawn error: ${err.message}\n`);
      reject(err);
    });

    // Send prompt via stdin and close it
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Parse token usage from Claude CLI stderr output.
 * Claude Code CLI outputs token info to stderr in various formats.
 */
export function parseTokenUsage(stderr: string, model: string): TokenUsage | undefined {
  // Try to match patterns like "Input tokens: 1234" / "Output tokens: 5678"
  const inputMatch = stderr.match(/input[\s_-]*tokens?[:\s]+(\d[\d,]*)/i);
  const outputMatch = stderr.match(/output[\s_-]*tokens?[:\s]+(\d[\d,]*)/i);

  if (inputMatch || outputMatch) {
    const cacheMatch = stderr.match(/cache[\s_-]*(?:read|hit)[\s_-]*tokens?[:\s]+(\d[\d,]*)/i);
    return {
      inputTokens: inputMatch ? parseInt(inputMatch[1].replace(/,/g, ''), 10) : 0,
      outputTokens: outputMatch ? parseInt(outputMatch[1].replace(/,/g, ''), 10) : 0,
      cacheReadTokens: cacheMatch ? parseInt(cacheMatch[1].replace(/,/g, ''), 10) : undefined,
      model,
    };
  }

  // Try to match total tokens pattern
  const totalMatch = stderr.match(/total[\s_-]*tokens?[:\s]+(\d[\d,]*)/i);
  if (totalMatch) {
    const total = parseInt(totalMatch[1].replace(/,/g, ''), 10);
    // Estimate 70% input / 30% output split
    return {
      inputTokens: Math.round(total * 0.7),
      outputTokens: Math.round(total * 0.3),
      model,
    };
  }

  return undefined;
}

/**
 * Run lint --fix and format commands (best-effort) so pre-commit hooks pass.
 */
async function runAutoFix(workDir: string, lintCmd?: string, fmtCmd?: string): Promise<void> {
  if (fmtCmd) {
    try {
      const [bin, ...args] = fmtCmd.split(' ');
      await execFileAsync(bin, args, { cwd: workDir });
    } catch {
      // Format failures are non-fatal — the commit hook will catch remaining issues
    }
  }
  if (lintCmd) {
    try {
      const [bin, ...args] = lintCmd.split(' ');
      await execFileAsync(bin, args, { cwd: workDir });
    } catch {
      // Lint --fix failures are non-fatal
    }
  }
}

export class ClaudeCodeRunner implements AgentRunner {
  async run(ctx: AgentContext): Promise<AgentResult> {
    const prompt = buildPrompt(ctx);

    try {
      // Invoke Claude Code CLI with stream-json for real-time progress
      const result = await runClaude(prompt, ctx.workDir, {
        allowedTools: ctx.allowedTools,
        timeoutMs: ctx.timeoutMs,
        model: ctx.model,
        sandboxId: ctx.sandboxId,
        onProgress: ctx.onProgress,
      });

      // Token usage from stream-json result event (falls back to stderr parsing)
      const tokenUsage = parseTokenUsage(result.stderr, result.model);

      // Collect changed files
      const diffOutput = await gitExec(ctx.workDir, ['diff', '--name-only']);
      const untrackedOutput = await gitExec(ctx.workDir, [
        'ls-files',
        '--others',
        '--exclude-standard',
      ]);

      const filesChanged = [
        ...diffOutput.split('\n').filter(Boolean),
        ...untrackedOutput.split('\n').filter(Boolean),
      ];

      if (filesChanged.length === 0) {
        return {
          success: false,
          filesChanged: [],
          summary: 'Agent made no changes',
          error: 'No files were modified',
          tokenUsage,
        };
      }

      // Stage, lint/format, and commit
      await gitExec(ctx.workDir, ['add', '-A']);

      // Run lint and format before committing to avoid pre-commit hook failures
      const lintCmd = ctx.lintCommand ?? DEFAULT_LINT_COMMAND;
      const fmtCmd = ctx.formatCommand ?? DEFAULT_FORMAT_COMMAND;
      await runAutoFix(ctx.workDir, lintCmd, fmtCmd);

      // Re-stage after auto-fix may have modified files
      await gitExec(ctx.workDir, ['add', '-A']);

      const tmpl = ctx.commitMessageTemplate ?? DEFAULT_COMMIT_MESSAGE_TEMPLATE;
      const coAuthor = ctx.commitCoAuthor ?? DEFAULT_COMMIT_CO_AUTHOR;
      const commitMsg = tmpl
        .replace(/\{issueNumber\}/g, ctx.issueId)
        .replace(/\{issueTitle\}/g, ctx.issueTitle);

      try {
        await gitExec(ctx.workDir, ['commit', '-m', `${commitMsg}\n\nCo-Authored-By: ${coAuthor}`]);
      } catch {
        // Pre-commit hook may have auto-fixed files — re-stage and retry once
        await runAutoFix(ctx.workDir, lintCmd, fmtCmd);
        await gitExec(ctx.workDir, ['add', '-A']);
        await gitExec(ctx.workDir, ['commit', '-m', `${commitMsg}\n\nCo-Authored-By: ${coAuthor}`]);
      }

      return {
        success: true,
        filesChanged,
        summary: result.stdout.slice(0, 2000),
        tokenUsage,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        filesChanged: [],
        summary: 'Agent execution failed',
        error: message,
      };
    }
  }
}

/** @deprecated Use ClaudeCodeRunner instead */
export const GitHubActionsRunner = ClaudeCodeRunner;
