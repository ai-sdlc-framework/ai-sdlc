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
    `You are fixing issue #${ctx.issueNumber}: ${ctx.issueTitle}`,
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
      `${++step}. Do NOT modify files matching the blocked paths below.`,
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
      `${++step}. Do NOT modify files matching the blocked paths below.`,
      `${++step}. Keep your changes to at most ${ctx.constraints.maxFilesPerChange} files.`,
    );
  }

  lines.push(
    '',
    '## Constraints',
    `- Maximum files to change: ${ctx.constraints.maxFilesPerChange}`,
    `- Tests required: ${ctx.constraints.requireTests}`,
    `- Blocked paths (do NOT modify): ${ctx.constraints.blockedPaths.join(', ') || 'none'}`,
  );

  // Append relevant episodic memory if available
  if (ctx.memory) {
    const episodes = ctx.memory.episodic.search(`issue-${ctx.issueNumber}`);
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
    const child = spawn('claude', ['-p', '--model', model, '--allowedTools', tools], {
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      timeout: timeoutMs,
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on('data', (data: Buffer) => chunks.push(data));
    child.stderr.on('data', (data: Buffer) => errChunks.push(data));

    child.on('close', (code) => {
      const stdout = Buffer.concat(chunks).toString('utf-8');
      const stderr = Buffer.concat(errChunks).toString('utf-8');
      if (code === 0) {
        resolve({ stdout, stderr, model });
      } else {
        reject(new Error(`claude exited with code ${code}: ${stderr || stdout}`));
      }
    });

    child.on('error', reject);

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

export class ClaudeCodeRunner implements AgentRunner {
  async run(ctx: AgentContext): Promise<AgentResult> {
    const prompt = buildPrompt(ctx);

    try {
      // Invoke Claude Code CLI in print mode, sending prompt via stdin
      const result = await runClaude(prompt, ctx.workDir, {
        allowedTools: ctx.allowedTools,
        timeoutMs: ctx.timeoutMs,
        model: ctx.model,
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

      // Stage and commit
      await gitExec(ctx.workDir, ['add', '-A']);
      const tmpl = ctx.commitMessageTemplate ?? DEFAULT_COMMIT_MESSAGE_TEMPLATE;
      const coAuthor = ctx.commitCoAuthor ?? DEFAULT_COMMIT_CO_AUTHOR;
      const commitMsg = tmpl
        .replace(/\{issueNumber\}/g, String(ctx.issueNumber))
        .replace(/\{issueTitle\}/g, ctx.issueTitle);
      await gitExec(ctx.workDir, ['commit', '-m', `${commitMsg}\n\nCo-Authored-By: ${coAuthor}`]);

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
