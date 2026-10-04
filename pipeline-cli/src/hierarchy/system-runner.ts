/**
 * The real command runner: spawns the program directly (no shell) and
 * captures its output. The bootstrap uses this in production; tests inject a
 * recording runner instead.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

import type { AsyncCommandRunner, CommandResult, CommandRunner } from './types.js';

/** Maximum bytes of output captured from one command. */
const MAX_BUFFER = 4 * 1024 * 1024;

/** Create a runner backed by `child_process.spawnSync`. */
export function createSystemRunner(): CommandRunner {
  return (file, args, options): CommandResult => {
    const result = spawnSync(file, [...args], {
      cwd: options?.cwd,
      encoding: 'utf-8',
      maxBuffer: MAX_BUFFER,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? (result.error ? result.error.message : ''),
    };
  };
}

/** Default time allowed for one git command, a push or rebase included. */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/** Variables that point git at a repository, index or configuration other than the working directory's. */
const GIT_LOCATION_VARS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]);

/**
 * The environment a playbook git command runs with: `base` without any variable
 * that redirects git (the repository, work tree, index, or any `GIT_CONFIG*`
 * setting) and with credential prompts turned off. Pure.
 */
export function buildGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (GIT_LOCATION_VARS.has(upper) || upper.startsWith('GIT_CONFIG')) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/**
 * Default time allowed for `git push`: the repository's pre-push hooks run inside
 * it and include the coverage gate.
 */
export const DEFAULT_GIT_PUSH_TIMEOUT_MS = 1_800_000;

/** Options of {@link createGitRunner}. All are for tests; none is exposed as a CLI flag. */
export interface GitRunnerOptions {
  /** Milliseconds a git command other than `push` may run before it is killed. */
  timeoutMs?: number;
  /** Milliseconds `git push` may run before it is killed. */
  pushTimeoutMs?: number;
  /** Environment to start from; default the process environment. */
  env?: NodeJS.ProcessEnv;
  /** Replaces `child_process.spawn`. */
  spawn?: typeof spawn;
  /** Replaces `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Replaces `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Replaces `clearTimeout`. */
  clearTimer?: (handle: unknown) => void;
}

/**
 * SIGKILL a whole process group (negative pid), so a hook's child processes die
 * with git. A missing pid or one that could name init or the caller's own group
 * (<= 1) is refused. An already-gone group (ESRCH) counts as success of intent.
 * Returns true when a signal was delivered.
 */
export function killProcessGroup(
  pid: number | undefined,
  kill: (pid: number, signal: NodeJS.Signals) => void = (p, sig) => process.kill(p, sig),
): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false;
  try {
    kill(-pid, 'SIGKILL');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    try {
      kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * A runner for git only: argv without a shell, the {@link buildGitEnv}
 * environment, and a timeout. `git push` gets the long push timeout; every other
 * command gets the default. Git is spawned detached, in its own process group,
 * and a timeout kills the whole group. Any other program is refused without being
 * run.
 */
export function createGitRunner(options: GitRunnerOptions = {}): AsyncCommandRunner {
  const timeout = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const pushTimeout = options.pushTimeoutMs ?? DEFAULT_GIT_PUSH_TIMEOUT_MS;
  const spawnProcess = options.spawn ?? spawn;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  return (file, args, runOptions) =>
    new Promise<CommandResult>((resolve) => {
      if (file !== 'git') {
        resolve({ status: null, stdout: '', stderr: `the git runner does not run '${file}'` });
        return;
      }
      const limit = args[0] === 'push' ? pushTimeout : timeout;
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer: { handle?: unknown } = {};
      const finish = (result: CommandResult): void => {
        if (settled) return;
        settled = true;
        if (timer.handle !== undefined) clearTimer(timer.handle);
        resolve(result);
      };
      let child: ChildProcess;
      try {
        child = spawnProcess('git', [...args], {
          cwd: runOptions?.cwd,
          env: buildGitEnv(options.env ?? process.env),
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        finish({
          status: null,
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const collect = (which: 'out' | 'err') => (chunk: Buffer | string) => {
        if (stdout.length + stderr.length >= MAX_BUFFER) return;
        if (which === 'out') stdout += String(chunk);
        else stderr += String(chunk);
      };
      child.stdout?.on('data', collect('out'));
      child.stderr?.on('data', collect('err'));
      child.on('error', (err) => finish({ status: null, stdout, stderr: stderr || err.message }));
      child.on('close', (code) => finish({ status: code, stdout, stderr }));
      timer.handle = setTimer(() => {
        killProcessGroup(child.pid, kill);
        finish({
          status: null,
          stdout,
          stderr:
            `${stderr}\ngit ${String(args[0])} timed out after ${limit} ms and its process group was killed`.trim(),
        });
      }, limit);
    });
}

/**
 * Run an interactive tmux command (`attach-session` or `switch-client`) with the
 * terminal's stdio inherited; returns the exit code.
 */
export function attachTmuxSession(args: readonly string[]): number {
  const result = spawnSync('tmux', [...args], { stdio: 'inherit' });
  return result.status ?? 1;
}
