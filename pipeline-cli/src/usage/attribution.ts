/**
 * Scope, repository and task attribution for ingested calls.
 *
 * A call is `framework` scope when its working directory sits inside a
 * repository root that holds an `.ai-sdlc/` directory; every other call is
 * `other` scope. Only filesystem metadata is consulted, never transcript
 * content. The working directory comes from an untrusted file, so it is
 * validated and only ever used for `lstat`/`readFile` of fixed names beneath its
 * own ancestors.
 */

import { lstatSync, type Stats, openSync, closeSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export interface FrameworkContext {
  /** Repository (or worktree) root that contains `.ai-sdlc/`. */
  root: string;
  /** Repository name; for a task worktree, the owning repository's name. */
  repo: string;
}

const MAX_WALK_DEPTH = 64;
const MAX_REPO_NAME = 200;
const SENTINEL_MAX_BYTES = 256;
const TASK_ID_FULL = /^[A-Za-z][A-Za-z0-9]*-\d+(?:\.\d+)*$/;
const TASK_ID_IN_TEXT = /[A-Za-z][A-Za-z0-9]*-\d+(?:\.\d+)*/g;
const TASK_FILE_ID = /^([A-Za-z][A-Za-z0-9]*-\d+(?:\.\d+)*) - /;
const WORKTREE_SEGMENT = /(?:^|[\\/])\.worktrees[\\/]([^\\/]+)/;

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function isRealDir(path: string): boolean {
  const st = lstatOrUndefined(path);
  return st !== undefined && st.isDirectory() && !st.isSymbolicLink();
}

/** A repository root has a `.git` entry (directory, or file for a worktree). */
function hasGitEntry(dir: string): boolean {
  return lstatOrUndefined(join(dir, '.git')) !== undefined;
}

export interface AttributionOptions {
  /** Directory never treated as a repository root. Defaults to the home directory. */
  homeDir?: string;
}

export class AttributionResolver {
  private readonly home: string;
  private readonly rootCache = new Map<string, FrameworkContext | null>();
  private readonly taskSetCache = new Map<string, Set<string>>();
  private readonly sentinelCache = new Map<string, string | undefined>();

  constructor(opts: AttributionOptions = {}) {
    this.home = resolve(opts.homeDir ?? homedir());
  }

  /** The framework repository containing `cwd`, or null. Cached per directory. */
  frameworkFor(cwd: string | undefined): FrameworkContext | null {
    if (!cwd || !isAbsolute(cwd) || cwd.includes('\0')) return null;
    const start = resolve(cwd);
    const cached = this.rootCache.get(start);
    if (cached !== undefined) return cached;

    let found: FrameworkContext | null = null;
    let dir = start;
    for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
      if (dir !== this.home && isRealDir(join(dir, '.ai-sdlc')) && hasGitEntry(dir)) {
        found = { root: dir, repo: repoNameFor(dir) };
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    this.rootCache.set(start, found);
    return found;
  }

  /**
   * Task id for a framework call: the worktree segment in `cwd`, then a known
   * task id in the branch name, then the `.active-task` sentinel in the root.
   */
  taskFor(
    ctx: FrameworkContext,
    cwd: string | undefined,
    branch: string | undefined,
  ): string | undefined {
    const seg = cwd ? WORKTREE_SEGMENT.exec(cwd)?.[1] : undefined;
    if (seg && TASK_ID_FULL.test(seg)) return seg.toUpperCase();

    if (branch) {
      const known = this.knownTaskIds(ctx.root);
      for (const m of branch.matchAll(TASK_ID_IN_TEXT)) {
        if (known.has(m[0].toUpperCase())) return m[0].toUpperCase();
      }
    }
    return this.sentinelTask(ctx.root);
  }

  /** Task ids that have a file under the repository's backlog. */
  private knownTaskIds(root: string): Set<string> {
    const cached = this.taskSetCache.get(root);
    if (cached) return cached;
    const ids = new Set<string>();
    for (const sub of ['tasks', 'completed']) {
      const dir = join(root, 'backlog', sub);
      if (!isRealDir(dir)) continue;
      try {
        for (const name of readdirSync(dir)) {
          const m = TASK_FILE_ID.exec(name);
          if (m) ids.add(m[1]!.toUpperCase());
        }
      } catch {
        // unreadable backlog: no known ids
      }
    }
    this.taskSetCache.set(root, ids);
    return ids;
  }

  private sentinelTask(root: string): string | undefined {
    if (this.sentinelCache.has(root)) return this.sentinelCache.get(root);
    let id: string | undefined;
    const path = join(root, '.active-task');
    const st = lstatOrUndefined(path);
    if (st && st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size <= SENTINEL_MAX_BYTES) {
      try {
        const fd = openSync(path, 'r');
        try {
          const buf = Buffer.alloc(st.size);
          const n = readSync(fd, buf, 0, st.size, 0);
          const text = buf.subarray(0, n).toString('utf-8').trim();
          if (TASK_ID_FULL.test(text)) id = text.toUpperCase();
        } finally {
          closeSync(fd);
        }
      } catch {
        // unreadable sentinel: no task
      }
    }
    this.sentinelCache.set(root, id);
    return id;
  }
}

function repoNameFor(root: string): string {
  const parent = dirname(root);
  const name = basename(parent) === '.worktrees' ? basename(dirname(parent)) : basename(root);
  return name.slice(0, MAX_REPO_NAME);
}
