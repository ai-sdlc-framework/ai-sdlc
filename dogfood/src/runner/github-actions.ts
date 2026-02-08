/**
 * GitHub Actions runner — invokes Claude Code CLI in --print mode
 * and collects the result via git diff.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRunner, AgentContext, AgentResult } from './types.js';

const execFileAsync = promisify(execFile);

function buildPrompt(ctx: AgentContext): string {
  const lines = [
    `You are fixing issue #${ctx.issueNumber}: ${ctx.issueTitle}`,
    '',
    '## Issue Description',
    ctx.issueBody,
    '',
    '## Constraints',
    `- Maximum files to change: ${ctx.constraints.maxFilesPerChange}`,
    `- Tests required: ${ctx.constraints.requireTests}`,
    `- Blocked paths (do NOT modify): ${ctx.constraints.blockedPaths.join(', ') || 'none'}`,
    '',
    '## Instructions',
    '1. Read the relevant source files to understand the codebase.',
    '2. Implement the fix or feature described in the issue.',
    '3. Write or update tests to cover your changes.',
    '4. Do NOT modify files matching the blocked paths above.',
    `5. Keep your changes to at most ${ctx.constraints.maxFilesPerChange} files.`,
  ];
  return lines.join('\n');
}

async function gitExec(workDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: workDir });
  return stdout.trim();
}

function runClaude(prompt: string, workDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', '--model', 'claude-opus-4-6', '--allowedTools', 'Edit,Write,Read,Glob,Grep,Bash'],
      {
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      },
    );

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

export class GitHubActionsRunner implements AgentRunner {
  async run(ctx: AgentContext): Promise<AgentResult> {
    const prompt = buildPrompt(ctx);

    try {
      // Invoke Claude Code CLI in print mode, sending prompt via stdin
      const stdout = await runClaude(prompt, ctx.workDir);

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
