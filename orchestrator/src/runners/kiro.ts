/**
 * Kiro CLI runner — invokes `kiro-cli chat` in headless (--no-interactive)
 * mode with stream-json output and collects the result via git diff.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRunner, AgentContext, AgentResult } from './types.js';
import {
  DEFAULT_RUNNER_TIMEOUT_MS,
  DEFAULT_KIRO_MODEL,
  DEFAULT_COMMIT_MESSAGE_TEMPLATE,
  DEFAULT_COMMIT_CO_AUTHOR,
} from '../defaults.js';
import { buildPrompt } from './claude-code.js';
import { cleanGitEnv } from '../runtime/git-env.js';

export { buildPrompt };

const execFileAsync = promisify(execFile);

// Kiro CLI ships as the standalone `kiro-cli` binary. Plain `kiro` opens the
// Kiro IDE unless the optional command router is installed, so it is not used.
const KIRO_CLI = 'kiro-cli';

const KIRO_NOT_FOUND =
  'Kiro CLI not found: `kiro-cli` is not on PATH (the `kiro` IDE launcher is not enough). ' +
  'Install it from https://kiro.dev/docs/cli/ and set KIRO_API_KEY.';

// Strip GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE so git resolves against
// `workDir`'s own .git rather than whatever a parent process leaked (AISDLC-72).
async function gitExec(workDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: workDir, env: cleanGitEnv() });
  return stdout.trim();
}

/**
 * Build the kiro-cli argv. `--trust-workspace` skips the V3 "trust this
 * workspace?" prompt and `--trust-all-tools` lets the agent edit files
 * without approval (as `--force` does for Cursor). `--model` is emitted only
 * when set. Auth comes from `KIRO_API_KEY` in the environment, never argv.
 */
export function buildKiroArgs(prompt: string, model: string | undefined): string[] {
  const args = [
    'chat',
    '--no-interactive',
    '--v3',
    '--trust-workspace',
    '--trust-all-tools',
    '--output-format',
    'stream-json',
  ];
  if (model) {
    args.push('--model', model);
  }
  args.push(prompt);
  return args;
}

export interface KiroStreamResult {
  /** True when the stream ends with `runFinished` and `status: "success"`. */
  succeeded: boolean;
  /** `finalText` from `runFinished`, else the streamed agent message text. */
  text: string;
  /** Reason from a `runError` or a non-success `runFinished`. */
  failure?: string;
}

/**
 * Parse JSONL from `kiro-cli chat --v3 --output-format stream-json`.
 * Each line is `{type, data}`. A run ends with `runFinished`
 * (`{status, stopReason, finalText}`) or `runError` (`{stage, message}`);
 * agent text streams as `sessionUpdate` events whose update is an
 * `agent_message_chunk`. Kiro reports usage in credits, not tokens, so no
 * token usage is extracted.
 */
export function parseKiroStream(stdout: string): KiroStreamResult {
  let succeeded = false;
  let finalText = '';
  let streamedText = '';
  let failure: string | undefined;

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const data = event?.data;
      if (event?.type === 'sessionUpdate') {
        const update = data?.update;
        if (
          update?.sessionUpdate === 'agent_message_chunk' &&
          typeof update.content?.text === 'string'
        ) {
          streamedText += update.content.text;
        }
      } else if (event?.type === 'runFinished') {
        succeeded = data?.status === 'success';
        finalText = typeof data?.finalText === 'string' ? data.finalText : '';
        failure = succeeded
          ? undefined
          : `run finished with status ${data?.status} (stopReason: ${data?.stopReason})`;
      } else if (event?.type === 'runError') {
        succeeded = false;
        failure = data?.stage ? `${data.stage} error: ${data.message}` : String(data?.message);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return { succeeded, text: finalText || streamedText, failure };
}

export class KiroRunner implements AgentRunner {
  async run(ctx: AgentContext): Promise<AgentResult> {
    const prompt = buildPrompt(ctx);
    const timeoutMs = ctx.timeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS;

    try {
      const kiroArgs = buildKiroArgs(prompt, DEFAULT_KIRO_MODEL);

      // When running inside an OpenShell sandbox, prefix with sandbox connect
      let cmd: string;
      let args: string[];
      if (ctx.sandboxId) {
        cmd = 'openshell';
        args = ['sandbox', 'connect', ctx.sandboxId, '--', KIRO_CLI, ...kiroArgs];
      } else {
        cmd = KIRO_CLI;
        args = kiroArgs;
      }

      const { stdout, stderr, code, signal } = await new Promise<{
        stdout: string;
        stderr: string;
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        const child = spawn(cmd, args, {
          cwd: ctx.workDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
          timeout: timeoutMs,
        });

        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];

        child.stdout.on('data', (data: Buffer) => chunks.push(data));
        child.stderr.on('data', (data: Buffer) => errChunks.push(data));

        child.on('close', (code, signal) => {
          resolve({
            stdout: Buffer.concat(chunks).toString('utf-8'),
            stderr: Buffer.concat(errChunks).toString('utf-8'),
            code,
            signal,
          });
        });

        child.on('error', (err: NodeJS.ErrnoException) => {
          reject(
            err.code === 'ENOENT' && cmd === KIRO_CLI
              ? new Error(KIRO_NOT_FOUND, { cause: err })
              : err,
          );
        });
      });

      // Success needs a zero exit and a successful runFinished event: kiro-cli
      // reports auth, model and prompt failures as a runError line on stdout.
      const stream = parseKiroStream(stdout);
      if (code !== 0 || !stream.succeeded) {
        const exit = signal ? `was terminated by ${signal}` : `exited with code ${code}`;
        const detail =
          stream.failure ?? (code === 0 ? 'no runFinished event in output' : stderr || stdout);
        throw new Error(`kiro-cli ${exit}: ${detail}`);
      }

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
      const tmpl = ctx.commitMessageTemplate ?? DEFAULT_COMMIT_MESSAGE_TEMPLATE;
      const coAuthor = ctx.commitCoAuthor ?? DEFAULT_COMMIT_CO_AUTHOR;
      const commitMsg = tmpl
        .replace(/\{issueNumber\}/g, ctx.issueId)
        .replace(/\{issueTitle\}/g, ctx.issueTitle);
      await gitExec(ctx.workDir, ['commit', '-m', `${commitMsg}\n\nCo-Authored-By: ${coAuthor}`]);

      return {
        success: true,
        filesChanged,
        summary: stream.text.slice(0, 2000),
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
