/**
 * GitHub Copilot CLI runner — invokes `copilot` in --yolo mode
 * and collects the result via git diff.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRunner, AgentContext, AgentResult, TokenUsage } from './types.js';
import {
  DEFAULT_RUNNER_TIMEOUT_MS,
  DEFAULT_COPILOT_MODEL,
  DEFAULT_COMMIT_MESSAGE_TEMPLATE,
  DEFAULT_COMMIT_CO_AUTHOR,
} from '../defaults.js';
import { buildPrompt } from './claude-code.js';

export { buildPrompt };

const execFileAsync = promisify(execFile);

async function gitExec(workDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: workDir });
  return stdout.trim();
}

/**
 * Parse token usage from Copilot CLI stderr output.
 */
export function parseTokenUsage(stderr: string, model: string): TokenUsage | undefined {
  const inputMatch = stderr.match(/input[\s_-]*tokens?[:\s]+(\d[\d,]*)/i);
  const outputMatch = stderr.match(/output[\s_-]*tokens?[:\s]+(\d[\d,]*)/i);

  if (inputMatch || outputMatch) {
    return {
      inputTokens: inputMatch ? parseInt(inputMatch[1].replace(/,/g, ''), 10) : 0,
      outputTokens: outputMatch ? parseInt(outputMatch[1].replace(/,/g, ''), 10) : 0,
      model,
    };
  }

  const totalMatch = stderr.match(/total[\s_-]*tokens?[:\s]+(\d[\d,]*)/i);
  if (totalMatch) {
    const total = parseInt(totalMatch[1].replace(/,/g, ''), 10);
    return {
      inputTokens: Math.round(total * 0.7),
      outputTokens: Math.round(total * 0.3),
      model,
    };
  }

  return undefined;
}

export class CopilotRunner implements AgentRunner {
  async run(ctx: AgentContext): Promise<AgentResult> {
    const prompt = buildPrompt(ctx);
    const timeoutMs = ctx.timeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS;
    const model = DEFAULT_COPILOT_MODEL ?? 'copilot-default';

    try {
      const args = ['-p', prompt, '--yolo'];
      if (DEFAULT_COPILOT_MODEL) {
        args.push('--model', DEFAULT_COPILOT_MODEL);
      }

      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn('copilot', args, {
            cwd: ctx.workDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env },
            timeout: timeoutMs,
          });

          const chunks: Buffer[] = [];
          const errChunks: Buffer[] = [];

          child.stdout.on('data', (data: Buffer) => chunks.push(data));
          child.stderr.on('data', (data: Buffer) => errChunks.push(data));

          child.on('close', (code) => {
            const out = Buffer.concat(chunks).toString('utf-8');
            const err = Buffer.concat(errChunks).toString('utf-8');
            if (code === 0) {
              resolve({ stdout: out, stderr: err });
            } else {
              reject(new Error(`copilot exited with code ${code}: ${err || out}`));
            }
          });

          child.on('error', reject);
        },
      );

      const tokenUsage = parseTokenUsage(stderr, model);

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
        summary: stdout.slice(0, 2000),
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
