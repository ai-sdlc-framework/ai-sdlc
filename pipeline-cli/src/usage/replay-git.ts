/**
 * Git access for reviewer replay.
 *
 * Every git call goes through an argv array (never a shell string), every
 * commit id is validated as 40 lowercase hex characters before it reaches an
 * argument, hooks are disabled, LFS smudging and user git config are off, and
 * the replayed commits are checked out into a throwaway local clone (its own
 * `.git`, no remote) under a `mkdtemp` directory outside the repository. The
 * clone is always removed. The operator repository's `.git` is never shared
 * with the session that reads the commit.
 *
 * @module usage/replay-git
 */

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  type Stats,
} from 'node:fs';
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

/** Prefix of every temporary holder directory a replay creates. */
export const REPLAY_HOLDER_PREFIX = 'ai-sdlc-replay-';
/** Directory name of the checkout inside a holder: `<tmpdir>/ai-sdlc-replay-*\/wt`. */
export const REPLAY_CHECKOUT_DIR = 'wt';

const REPLAY_CWD = new RegExp(
  `(?:^|[\\\\/])${REPLAY_HOLDER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\\\/]+[\\\\/]${REPLAY_CHECKOUT_DIR}(?:[\\\\/]|$)`,
);

/**
 * True when a working directory is a replay checkout. The ingester uses this
 * to skip the replay session's own transcript: the replay records its usage
 * directly, so the transcript would count it twice.
 */
export function isReplayWorktreeCwd(cwd: string): boolean {
  return REPLAY_CWD.test(cwd);
}

export const REPLAY_GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  // A malicious commit must not trigger a filter, LFS download or user-defined driver.
  GIT_LFS_SKIP_SMUDGE: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
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
      env: REPLAY_GIT_ENV,
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

/** Names removed at any depth: per-directory instruction files and per-directory settings. */
const CONFIG_NAMES_ANY_DEPTH = new Set(['CLAUDE.md', 'CLAUDE.local.md', '.claude']);
/** Names removed at the top of the tree only. */
const CONFIG_NAMES_TOP_LEVEL = new Set(['.mcp.json', '.claude.json']);

/**
 * Delete every Claude Code configuration the replayed commit carries, so no
 * hook, agent, MCP server, setting or instruction file from it can load into
 * the session whatever the CLI's flags do: `.claude/` (any depth), `.mcp.json`,
 * `.claude.json`, and every `CLAUDE.md` / `CLAUDE.local.md`. Uses lstat and
 * removes a link itself, never what it points to. The review diff is computed
 * commit to commit, so removing working-tree files does not change it.
 * Returns the number of entries removed.
 */
export function removeCommitClaudeConfig(root: string): number {
  let removed = 0;
  const walk = (dir: string, top: boolean): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (CONFIG_NAMES_ANY_DEPTH.has(e.name) || (top && CONFIG_NAMES_TOP_LEVEL.has(e.name))) {
        try {
          rmSync(path, { recursive: true, force: true });
          removed++;
        } catch {
          // best effort; a leftover is caught by the sandbox flags
        }
        continue;
      }
      // A symlink Dirent is neither a directory nor a file here: it is never followed.
      if (e.isDirectory() && e.name !== '.git') walk(path, false);
    }
  };
  walk(root, true);
  return removed;
}

/** Clones created and not yet removed, so a signal handler can remove them. */
const active = new Map<string, { holder: string }>();

/** Remove every live replay clone synchronously. Used by signal handlers. */
export function cleanupActiveWorktreesSync(): number {
  let n = 0;
  for (const [path, { holder }] of [...active]) {
    removeHolderSync(holder);
    active.delete(path);
    n++;
  }
  return n;
}

function removeHolderSync(holder: string): void {
  try {
    rmSync(holder, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export function activeWorktreeCount(): number {
  return active.size;
}

/** Current uid, or undefined where the platform has none (Windows). */
function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/** True when the entry belongs to `uid`; with no uid to compare, every entry counts as owned. */
export function isOwnedByUser(st: Pick<Stats, 'uid'>, uid: number | undefined): boolean {
  return uid === undefined || st.uid === uid;
}

/** Name of the private per-user parent that holds run holders inside a shared temp directory. */
export function privateParentName(uid: number | undefined): string {
  return `${REPLAY_HOLDER_PREFIX}u${uid ?? 'x'}`;
}

/**
 * Create (or verify) the private 0700 per-user parent under a shared temp
 * directory. A pre-planted symlink, a foreign-owned directory or a looser mode
 * that cannot be tightened is refused, so another local user cannot swap the
 * parent or read the holders.
 */
function ensurePrivateParent(root: string, uid: number | undefined): string {
  const dir = join(root, privateParentName(uid));
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || !isOwnedByUser(st, uid)) {
    throw new Error('The replay temp parent is not a private directory owned by this user.');
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return dir;
}

export const STALE_HOLDER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface SweepOptions {
  /** Directory to sweep. Defaults to the OS temp directory. */
  root?: string;
  /** The OS temp directory; the sweep refuses any other root. Tests override it. */
  osTmpdir?: string;
  now?: number;
  maxAgeMs?: number;
  /** Only entries owned by this uid are removed. Defaults to the current uid. */
  uid?: number;
}

/**
 * Remove holders a killed run left behind: directories named
 * `ai-sdlc-replay-*` directly under the OS temp directory, older than
 * `maxAgeMs`, not symlinks, and not owned by a live run. Returns the count.
 */
export function sweepStaleReplayHolders(opts: SweepOptions = {}): number {
  const os = opts.osTmpdir ?? tmpdir();
  const root = opts.root ?? os;
  try {
    if (realpathSync(root) !== realpathSync(os)) return 0;
  } catch {
    return 0;
  }
  const uid = opts.uid ?? currentUid();
  const live = new Set([...active.values()].map((a) => a.holder));
  const cutoff = (opts.now ?? Date.now()) - (opts.maxAgeMs ?? STALE_HOLDER_MAX_AGE_MS);
  const sweepDir = (dir: string, nested: boolean): number => {
    let n = 0;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (!name.startsWith(REPLAY_HOLDER_PREFIX)) continue;
      const path = join(dir, name);
      if (live.has(path)) continue;
      try {
        const st = lstatSync(path);
        // Never follow a link, and never touch another user's entry in a shared directory.
        if (st.isSymbolicLink() || !st.isDirectory() || !isOwnedByUser(st, uid)) continue;
        if (!nested && name === privateParentName(uid)) {
          n += sweepDir(path, true);
          continue;
        }
        if (st.mtimeMs > cutoff) continue;
        rmSync(path, { recursive: true, force: true });
        n++;
      } catch {
        // best effort
      }
    }
    return n;
  };
  return sweepDir(root, false);
}

export interface TempCloneOptions {
  /** Directory to create the holder under. Defaults to the OS temp directory. */
  tmpRoot?: string;
  /**
   * Put the holder under a private 0700 per-user parent. Defaults to true when
   * `tmpRoot` is the OS temp directory (shared between users), false otherwise.
   */
  privateParent?: boolean;
  /** Owner uid the private parent must have (tests). Defaults to the current uid. */
  uid?: number;
}

/** Checks a commit out into the throwaway clone and returns the clone path. */
export type CheckoutFn = (sha: string) => Promise<string>;

/**
 * Create a throwaway local clone of the repository (copied objects, its own
 * `.git`, no remote, hooks off) under a fresh `mkdtemp` directory, run `fn`
 * with a function that checks a commit out into it, and remove the clone
 * whatever happens. A clone, not a linked worktree: a linked worktree shares
 * the operator repository's `.git`, which a replayed commit must never reach.
 */
export async function withReplayClone<T>(
  git: Git,
  repoRoot: string,
  fn: (checkout: CheckoutFn) => Promise<T>,
  opts: TempCloneOptions = {},
): Promise<T> {
  const root = opts.tmpRoot ?? tmpdir();
  const usePrivate =
    opts.privateParent ??
    (() => {
      try {
        return realpathSync(root) === realpathSync(tmpdir());
      } catch {
        return true;
      }
    })();
  const parent = usePrivate ? ensurePrivateParent(root, opts.uid ?? currentUid()) : root;
  const holder = mkdtempSync(join(parent, REPLAY_HOLDER_PREFIX));
  const path = join(holder, REPLAY_CHECKOUT_DIR);
  active.set(path, { holder });
  try {
    const clone = await git(
      [
        // Committed symlinks become plain files, so a session cannot follow one out of the clone.
        '-c',
        'core.symlinks=false',
        'clone',
        '--quiet',
        '--no-hardlinks',
        '--local',
        '--no-checkout',
        '--',
        repoRoot,
        path,
      ],
      holder,
    );
    if (clone.code !== 0) throw new Error('Could not create a throwaway clone for the replay.');
    // The clone must not be able to reach the operator repository again.
    await git(['remote', 'remove', 'origin'], path);
    await git(['config', 'core.hooksPath', '/dev/null'], path);
    await git(['config', 'core.fsmonitor', 'false'], path);
    await git(['config', 'core.symlinks', 'false'], path);
    const checkout: CheckoutFn = async (sha) => {
      if (!isCommitId(sha)) {
        throw new Error('Refusing to check out a value that is not a commit id.');
      }
      const r = await git(['checkout', '--quiet', '--force', '--detach', sha], path);
      if (r.code !== 0) throw new Error('Could not check the commit out in the throwaway clone.');
      await git(['clean', '-ffdxq'], path);
      removeCommitClaudeConfig(path);
      return path;
    };
    return await fn(checkout);
  } finally {
    // Synchronous so it also completes while the process is shutting down.
    removeHolderSync(holder);
    active.delete(path);
  }
}
