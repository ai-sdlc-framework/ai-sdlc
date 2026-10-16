/**
 * AISDLC-825 — resolve the decision-catalog root.
 *
 * From a linked worktree (`.worktrees/<id>/`) the catalog root is the MAIN
 * checkout, so `cli-decisions add|answer|show|list` agree wherever they run and
 * dispatch (in the parent) can route a decision an executor filed from its
 * worktree. Outside a linked worktree the directory is returned unchanged.
 */
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

export function resolveCatalogRoot(dir: string): string {
  const gitDir = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!gitDir || !common) return dir;
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  if (real(gitDir) === real(common)) return dir; // not a linked worktree
  if (basename(common) !== '.git') return dir; // bare or unusual layout
  return dirname(common);
}

/**
 * AISDLC-874 — resolve where a WRITE (`add`, `answer`, `escalate`) lands.
 *
 * Reads use {@link resolveCatalogRoot} (the main checkout). Writes must never
 * land untracked in a Pattern-C parent, so:
 *  - from a linked worktree: that worktree's own store;
 *  - from the parent with an active task (`AI_SDLC_ACTIVE_TASK_ID`): that
 *    task's worktree `.worktrees/<id>/`;
 *  - from the parent with no active task: refuse (throws).
 * Anything that is not a Pattern-C parent (no `.worktrees/` dir) is unchanged.
 */
export function resolveWriteRoot(
  dir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (resolveCatalogRoot(dir) !== dir) return dir; // linked worktree: its own store
  if (!existsSync(join(dir, '.worktrees'))) return dir; // not a Pattern-C parent
  const taskId = env.AI_SDLC_ACTIVE_TASK_ID?.trim();
  if (taskId && /^[A-Za-z0-9._-]+$/.test(taskId)) {
    const wt = join(dir, '.worktrees', taskId.toLowerCase());
    if (existsSync(wt)) return wt;
    throw new Error(
      `[cli-decisions] refusing to write: active task ${taskId} has no worktree at ${wt}.`,
    );
  }
  throw new Error(
    `[cli-decisions] refusing to write from the Pattern-C parent (${dir}) with no active task: ` +
      'the event would land untracked in the parent. Run from the task worktree ' +
      '(.worktrees/<task-id>/) or set AI_SDLC_ACTIVE_TASK_ID.',
  );
}
