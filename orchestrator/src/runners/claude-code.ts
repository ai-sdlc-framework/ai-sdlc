/**
 * Claude Code runner — invokes Claude Code CLI in --print mode
 * and collects the result via git diff.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRunner, AgentContext, AgentResult, TokenUsage } from './types.js';
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

export function buildPrompt(ctx: AgentContext): string {
  const lintCmd = ctx.lintCommand ?? DEFAULT_LINT_COMMAND;
  const fmtCmd = ctx.formatCommand ?? DEFAULT_FORMAT_COMMAND;

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
    if (lintCmd && fmtCmd) {
      lines.push(
        `${++step}. After making ANY code changes, always run \`${lintCmd}\` and \`${fmtCmd}\` to catch issues before committing.`,
      );
    } else if (lintCmd) {
      lines.push(
        `${++step}. After making ANY code changes, always run \`${lintCmd}\` to catch issues before committing.`,
      );
    } else if (fmtCmd) {
      lines.push(
        `${++step}. After making ANY code changes, always run \`${fmtCmd}\` to catch issues before committing.`,
      );
    }
    lines.push(
      `${++step}. Write or update tests if needed to cover your fix.`,
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
    if (lintCmd && fmtCmd) {
      lines.push(
        `${++step}. After making code changes, run \`${lintCmd}\` and \`${fmtCmd}\` to ensure CI will pass.`,
      );
    } else if (lintCmd) {
      lines.push(
        `${++step}. After making code changes, run \`${lintCmd}\` to ensure CI will pass.`,
      );
    } else if (fmtCmd) {
      lines.push(`${++step}. After making code changes, run \`${fmtCmd}\` to ensure CI will pass.`);
    }
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
}

interface RunClaudeResult {
  stdout: string;
  stderr: string;
  model: string;
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
    const claudeArgs = ['-p', '--model', model, '--allowedTools', tools];

    // When running inside an OpenShell sandbox, prefix with sandbox connect.
    // Only use openshell when the provider is explicitly set — the stub sandbox
    // also returns a sandboxId but doesn't have a real openshell process.
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

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let lastActivity = Date.now();

    child.stdout.on('data', (data: Buffer) => {
      chunks.push(data);
      lastActivity = Date.now();
    });

    child.stderr.on('data', (data: Buffer) => {
      errChunks.push(data);
      lastActivity = Date.now();
      // Stream stderr to parent for real-time observability in CI
      process.stderr.write(data);
    });

    // Heartbeat: log progress every 30s so CI knows the process is alive
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const idle = Math.round((Date.now() - lastActivity) / 1000);
      const stdoutBytes = chunks.reduce((n, c) => n + c.length, 0);
      const stderrBytes = errChunks.reduce((n, c) => n + c.length, 0);
      process.stderr.write(
        `${logPrefix} heartbeat: ${elapsed}s elapsed, ${idle}s since last output, stdout=${stdoutBytes}B stderr=${stderrBytes}B\n`,
      );
    }, 30_000);

    child.on('close', (code) => {
      clearInterval(heartbeat);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const stdout = Buffer.concat(chunks).toString('utf-8');
      const stderr = Buffer.concat(errChunks).toString('utf-8');
      process.stderr.write(
        `${logPrefix} exited: code=${code} elapsed=${elapsed}s stdout=${stdout.length}B stderr=${stderr.length}B\n`,
      );
      if (code === 0) {
        resolve({ stdout, stderr, model });
      } else {
        reject(new Error(`claude exited with code ${code}: ${stderr || stdout}`));
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
      // Invoke Claude Code CLI in print mode, sending prompt via stdin
      const result = await runClaude(prompt, ctx.workDir, {
        allowedTools: ctx.allowedTools,
        timeoutMs: ctx.timeoutMs,
        model: ctx.model,
        sandboxId: ctx.sandboxId,
      });

      // Parse token usage from stderr
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
