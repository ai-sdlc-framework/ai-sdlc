/**
 * Claude Code runner — invokes Claude Code CLI in --print mode
 * and collects the result via git diff.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRunner, AgentContext, AgentResult } from './types.js';
import {
  DEFAULT_MODEL,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_RUNNER_TIMEOUT_MS,
} from '../defaults.js';
import { formatContextForPrompt } from '../analysis/context-builder.js';

const execFileAsync = promisify(execFile);

export function buildPrompt(ctx: AgentContext): string {
  const lines = [
    `You are fixing issue #${ctx.issueNumber}: ${ctx.issueTitle}`,
    '',
    '## Issue Description',
    ctx.issueBody,
    '',
  ];

  if (ctx.ciErrors) {
    lines.push(
      '## CI Failure Logs',
      '',
      '```',
      ctx.ciErrors,
      '```',
      '',
      '## Instructions',
      '1. Analyze the CI failure logs above to identify the root cause.',
      '2. Read the relevant source files to understand the context.',
      '3. Fix the errors that caused CI to fail.',
      '4. If the failure is a formatting/prettier error, run `pnpm format` to auto-fix it.',
      '5. After making ANY code changes, always run `pnpm lint` and `pnpm format` to catch issues before committing.',
      '6. Write or update tests if needed to cover your fix.',
      '7. Do NOT modify files matching the blocked paths below.',
      `8. Keep your changes to at most ${ctx.constraints.maxFilesPerChange} files.`,
    );
  } else {
    lines.push(
      '## Instructions',
      '1. Read the relevant source files to understand the codebase.',
      '2. Implement the fix or feature described in the issue.',
      '3. Write or update tests to cover your changes.',
      '4. After making code changes, run `pnpm lint` and `pnpm format` to ensure CI will pass.',
      '5. Do NOT modify files matching the blocked paths below.',
      `6. Keep your changes to at most ${ctx.constraints.maxFilesPerChange} files.`,
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
}

function runClaude(prompt: string, workDir: string, opts?: RunClaudeOptions): Promise<string> {
  const tools = opts?.allowedTools?.join(',') ?? DEFAULT_ALLOWED_TOOLS;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const model = process.env.AI_SDLC_MODEL ?? DEFAULT_MODEL;
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
      if (code === 0) {
        resolve(stdout);
      } else {
        const stderr = Buffer.concat(errChunks).toString('utf-8');
        reject(new Error(`claude exited with code ${code}: ${stderr || stdout}`));
      }
    });

    child.on('error', reject);

    // Send prompt via stdin and close it
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export class ClaudeCodeRunner implements AgentRunner {
  async run(ctx: AgentContext): Promise<AgentResult> {
    const prompt = buildPrompt(ctx);

    try {
      // Invoke Claude Code CLI in print mode, sending prompt via stdin
      const stdout = await runClaude(prompt, ctx.workDir, {
        allowedTools: ctx.allowedTools,
        timeoutMs: ctx.timeoutMs,
      });

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
        };
      }

      // Stage and commit
      await gitExec(ctx.workDir, ['add', '-A']);
      await gitExec(ctx.workDir, [
        'commit',
        '-m',
        `fix: resolve issue #${ctx.issueNumber}\n\n${ctx.issueTitle}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`,
      ]);

      return {
        success: true,
        filesChanged,
        summary: stdout.slice(0, 2000),
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
