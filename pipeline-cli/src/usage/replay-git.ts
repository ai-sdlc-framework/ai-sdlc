/**
 * Git access for reviewer replay.
 *
 * Every git call goes through an argv array (never a shell string), every
 * commit id is validated as 40 lowercase hex characters before it reaches an
 * argument, hooks are disabled, and temporary worktrees live under a
 * `mkdtemp` directory outside the repository and are always removed.
 *
 * @module usage/replay-git
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';

const COMMIT_ID = /^[0-9a-f]{40}$/;
const SAFE_REF = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/;

export function isCommitId(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_ID.test(value);
}

/** A ref name that cannot be read as an option and carries no shell or revision syntax. */
export function isSafeRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SAFE_REF.test(value) &&
    !value.includes('..') &&
    !value.endsWith('/') &&
    !value.endsWith('.lock')
  );
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
/** Global flags put before the subcommand: no hooks run during a replay checkout. */
const SAFE_GLOBAL = ['-c', 'core.hooksPath=/dev/null'];

export interface GitRun {
  code: number;
  stdout: string;
}

export type Git = (args: string[], cwd: string) => Promise<GitRun>;

/** The default git runner: execFile with an argv array and a bounded time. */
export function createGit(runner: Runner = defaultRunner): Git {
  return async (args, cwd) => {
    const r = await runner('git', [...SAFE_GLOBAL, ...args], {
      cwd,
      allowFailure: true,
      timeout: 120_000,
      env: GIT_ENV,
    });
    return { code: r.code, stdout: r.stdout };
  };
}

/** True when the commit object exists in the repository. */
export async function commitExists(git: Git, repoRoot: string, sha: string): Promise<boolean> {
  if (!isCommitId(sha)) return false;
  const r = await git(['cat-file', '-e', `${sha}^{commit}`], repoRoot);
  return r.code === 0;
}

/** Merge base of a commit and a base ref, or undefined when there is none. */
export async function mergeBaseOf(
  git: Git,
  repoRoot: string,
  sha: string,
  baseRef: string,
): Promise<string | undefined> {
  if (!isCommitId(sha) || !isSafeRef(baseRef)) return undefined;
  const r = await git(['merge-base', sha, baseRef], repoRoot);
  const out = r.stdout.trim();
  return r.code === 0 && isCommitId(out) ? out : undefined;
}

/** Worktrees created and not yet removed, so a signal handler can remove them. */
const active = new Map<string, { repoRoot: string; holder: string }>();

/** Remove every live replay worktree synchronously. Used by signal handlers. */
export function cleanupActiveWorktreesSync(): number {
  let n = 0;
  for (const [path, { repoRoot, holder }] of [...active]) {
    removeWorktreeSync(repoRoot, path, holder);
    active.delete(path);
    n++;
  }
  return n;
}

function removeWorktreeSync(repoRoot: string, path: string, holder: string): void {
  try {
    execFileSync('git', [...SAFE_GLOBAL, 'worktree', 'remove', '--force', path], {
      cwd: repoRoot,
      stdio: 'ignore',
      env: { ...process.env, ...GIT_ENV },
    });
  } catch {
    // the directory removal below is the backstop
  }
  try {
    rmSync(holder, { recursive: true, force: true });
  } catch {
    // best effort
  }
  try {
    execFileSync('git', [...SAFE_GLOBAL, 'worktree', 'prune'], {
      cwd: repoRoot,
      stdio: 'ignore',
      env: { ...process.env, ...GIT_ENV },
    });
  } catch {
    // best effort
  }
}

export function activeWorktreeCount(): number {
  return active.size;
}

export interface TempWorktreeOptions {
  /** Directory to create the holder under. Defaults to the OS temp directory. */
  tmpRoot?: string;
}

/**
 * Check a commit out into a detached worktree under a fresh `mkdtemp`
 * directory, run `fn` against it, and remove the worktree whatever happens.
 */
export async function withTempWorktree<T>(
  git: Git,
  repoRoot: string,
  sha: string,
  fn: (worktreePath: string) => Promise<T>,
  opts: TempWorktreeOptions = {},
): Promise<T> {
  if (!isCommitId(sha)) throw new Error('Refusing to check out a value that is not a commit id.');
  const holder = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), 'ai-sdlc-replay-'));
  const path = join(holder, 'wt');
  active.set(path, { repoRoot, holder });
  try {
    const add = await git(['worktree', 'add', '--detach', path, sha], repoRoot);
    if (add.code !== 0) throw new Error('Could not create a temporary worktree for the commit.');
    return await fn(path);
  } finally {
    // Synchronous so it also completes while the process is shutting down.
    removeWorktreeSync(repoRoot, path, holder);
    active.delete(path);
  }
}
