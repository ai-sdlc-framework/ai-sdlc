/**
 * Thin wrapper around `child_process.execFile` returning a typed `{stdout, stderr, code}`.
 * Steps inject this when they want to run `git`, `gh`, etc., so tests can swap a fake.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface ExecOptions {
  cwd?: string;
  /** Per-call timeout in ms (default 60s). */
  timeout?: number;
  /** Suppress throw on non-zero exit; return the result instead. */
  allowFailure?: boolean;
  /** Optional env overrides merged on top of process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Step-level command runner. Centralised so tests can mock by swapping the
 * `Runner` parameter that every step accepts.
 */
export type Runner = (command: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

/**
 * Default runner — backed by `child_process.execFile`. Steps that don't
 * receive an injected runner default to this.
 */
export const defaultRunner: Runner = async (command, args, opts = {}) => {
  try {
    const result = await execFileP(command, args, {
      cwd: opts.cwd,
      timeout: opts.timeout ?? 60_000,
      env: { ...process.env, ...opts.env },
      maxBuffer: 32 * 1024 * 1024,
    });
    const stdout = result.stdout as string | Buffer;
    const stderr = result.stderr as string | Buffer;
    return {
      stdout: typeof stdout === 'string' ? stdout : stdout.toString('utf8'),
      stderr: typeof stderr === 'string' ? stderr : stderr.toString('utf8'),
      code: 0,
    };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
      message?: string;
    };
    const result: ExecResult = {
      stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? ''),
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? ''),
      code: typeof e.code === 'number' ? e.code : 1,
    };
    if (opts.allowFailure) {
      return result;
    }
    const reason = result.stderr || result.stdout || e.message || 'command failed';
    const exposed = new Error(`${command} ${args.join(' ')} failed: ${reason.trim()}`);
    (exposed as Error & { result?: ExecResult }).result = result;
    throw exposed;
  }
};
