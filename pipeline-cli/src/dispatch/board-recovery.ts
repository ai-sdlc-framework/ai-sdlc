/**
 * Dispatch board recovery (AISDLC-1130): rebuild the board from GitHub PR state and
 * `backlog/`, a daily tarball backup of the board, and restore from one.
 *
 * The board (`.ai-sdlc/dispatch/`) is gitignored runtime state. Rebuild derives what it can
 * from open and merged PRs whose titles carry a task id plus `backlog/completed/`; every
 * verdict it writes carries `rebuilt: true` so it is never mistaken for an executor's own.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findTaskFileRelative } from '../dor/dispatch-readiness.js';
import type { CommandRunner } from '../hierarchy/types.js';
import { boardStateOf, writeManifest, writeVerdict } from './board.js';
import { DEFAULT_VERIFY_COMMANDS } from './enqueue.js';
import type { DispatchManifest, DispatchVerdict } from './types.js';

/** Backups kept per repository. */
export const BACKUPS_KEPT = 7;

/** One pull request as the rebuild reads it from the single `gh pr list` call. */
export interface RebuildPr {
  number: number;
  title: string;
  state: string;
  isDraft?: boolean;
  headRefName?: string;
  mergedAt?: string | null;
  url?: string;
}

export type RebuildAction = 'done' | 'failed' | 'queued';

export interface RebuildItem {
  taskId: string;
  action: RebuildAction;
  prNumber?: number;
  prUrl?: string;
  branch?: string;
  mergedAt?: string;
  source: 'merged-pr' | 'open-pr' | 'completed-task';
}

export interface RebuildPlan {
  items: RebuildItem[];
  counts: { done: number; failed: number; queued: number };
}

const TASK_ID_IN_TITLE = /\b([A-Z][A-Z0-9]*-\d+(?:\.\d+)*)\b/;

/** The task id a PR title names (`... (AISDLC-123)`), or undefined. */
export function taskIdFromTitle(title: string): string | undefined {
  const tail = title.match(/\(([A-Z][A-Z0-9]*-\d+(?:\.\d+)*)\)\s*$/);
  return (tail ?? title.match(TASK_ID_IN_TITLE))?.[1];
}

/**
 * Classify PRs and completed tasks into board entries. A merged PR is `done`; an open
 * non-draft PR is `failed` (PR follow-up, the shape `requeue` expects); an open draft PR
 * is `queued`. A task with an open PR is never also marked done. Closed-unmerged PRs are
 * ignored. A completed task with no merged PR is `done` with no PR.
 */
export function classifyRebuild(
  prs: readonly RebuildPr[],
  completedIds: readonly string[],
  activeIds: readonly string[] = [],
): RebuildPlan {
  const byTask = new Map<string, RebuildItem>();
  const open = new Set<string>();
  for (const pr of prs) {
    const taskId = taskIdFromTitle(pr.title);
    if (!taskId) continue;
    const state = pr.state.toUpperCase();
    if (state === 'OPEN') {
      open.add(taskId);
      byTask.set(taskId, {
        taskId,
        action: pr.isDraft ? 'queued' : 'failed',
        prNumber: pr.number,
        ...(pr.url ? { prUrl: pr.url } : {}),
        ...(pr.headRefName ? { branch: pr.headRefName } : {}),
        source: 'open-pr',
      });
    } else if (state === 'MERGED' && !open.has(taskId)) {
      const prior = byTask.get(taskId);
      if (prior?.action === 'done' && (prior.prNumber ?? 0) > pr.number) continue;
      byTask.set(taskId, {
        taskId,
        action: 'done',
        prNumber: pr.number,
        ...(pr.url ? { prUrl: pr.url } : {}),
        ...(pr.headRefName ? { branch: pr.headRefName } : {}),
        ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
        source: 'merged-pr',
      });
    }
  }
  // An open PR wins over an earlier-seen merged one for the same task.
  for (const id of open) {
    const item = byTask.get(id);
    if (item && item.source !== 'open-pr') byTask.delete(id);
  }
  for (const id of completedIds) {
    if (!byTask.has(id) && !open.has(id))
      byTask.set(id, { taskId: id, action: 'done', source: 'completed-task' });
  }
  for (const id of activeIds) byTask.delete(id);
  const items = [...byTask.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
  const counts = { done: 0, failed: 0, queued: 0 };
  for (const i of items) counts[i.action]++;
  return { items, counts };
}

/** Task ids of the files in a backlog directory (`aisdlc-12 - title.md` gives `AISDLC-12`). */
export function backlogTaskIds(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const ids: string[] = [];
  for (const f of readdirSync(dir)) {
    const m = f.match(/^([A-Za-z][A-Za-z0-9]*-\d+(?:\.\d+)*)\b/);
    if (m && f.endsWith('.md')) ids.push(m[1]!.toUpperCase());
  }
  return ids;
}

/** One `gh pr list --state all` call; throws when GitHub cannot be read. */
export function listAllPrs(run: CommandRunner, cwd: string, limit = 1000): RebuildPr[] {
  const r = run(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'all',
      '--limit',
      String(limit),
      '--json',
      'number,title,state,isDraft,headRefName,mergedAt,url',
    ],
    { cwd },
  );
  if (r.status !== 0) throw new Error(`gh pr list failed: ${r.stderr.trim() || r.status}`);
  return JSON.parse(r.stdout) as RebuildPr[];
}

/** True when no manifest or verdict is on the board. */
export function boardIsEmpty(boardDir: string): boolean {
  for (const sub of ['queue', 'inflight', 'done', 'failed', 'blocked']) {
    const dir = path.join(boardDir, sub);
    if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.json'))) return false;
  }
  return true;
}

/** The hint `cli-hierarchy up` prints, or null when the board holds something or nothing is completed. */
export function boardRecoveryHint(boardDir: string, repoRoot: string): string | null {
  if (!boardIsEmpty(boardDir)) return null;
  if (backlogTaskIds(path.join(repoRoot, 'backlog', 'completed')).length === 0) return null;
  return `the dispatch board at ${boardDir} is empty but backlog/completed/ is not; to rebuild it from GitHub run: node pipeline-cli/bin/cli-dispatch.mjs rebuild --from-github --board-dir ${boardDir} (add --dry-run to preview). See docs/operations/board-recovery.md`;
}

export interface ApplyOptions {
  boardDir: string;
  repoRoot: string;
  baseSha: string;
  now: Date;
}

/** Write the plan to the board. Entries already on the board in any state are left alone. */
export function applyRebuild(plan: RebuildPlan, o: ApplyOptions): RebuildPlan['counts'] {
  const written = { done: 0, failed: 0, queued: 0 };
  const at = o.now.toISOString();
  for (const item of plan.items) {
    if (boardStateOf(o.boardDir, item.taskId) !== undefined) continue;
    if (item.action === 'queued') {
      const manifest: DispatchManifest = {
        schemaVersion: 'v1',
        taskId: item.taskId,
        branch: item.branch ?? `ai-sdlc/${item.taskId.toLowerCase()}`,
        worktree: path.join(o.repoRoot, '.worktrees', item.taskId.toLowerCase()),
        baseSha: o.baseSha,
        workerKind: 'any',
        dispatchedAt: at,
        dispatchedBy: 'board-rebuild',
        spec: {
          taskFile:
            findTaskFileRelative(item.taskId, o.repoRoot) ??
            `backlog/tasks/${item.taskId.toLowerCase()}.md`,
          verifyCommands: [...DEFAULT_VERIFY_COMMANDS],
        },
      };
      writeManifest(o.boardDir, manifest);
    } else {
      const verdict: DispatchVerdict = {
        schemaVersion: 'v1',
        taskId: item.taskId,
        outcome: item.action === 'done' ? 'success' : 'failed',
        ...(item.prNumber === undefined ? {} : { prNumber: item.prNumber }),
        ...(item.prUrl ? { prUrl: item.prUrl } : {}),
        ...(item.branch ? { pushedBranch: item.branch } : {}),
        ...(item.action === 'failed' ? { cause: 'rebuilt-open-pr' } : {}),
        ...(item.action === 'done' ? { landed: item.mergedAt ?? at } : {}),
        notes: `rebuilt from ${item.source}`,
        completedAt: item.mergedAt ?? at,
        workerId: 'board-rebuild',
        rebuilt: true,
      };
      writeVerdict(o.boardDir, verdict);
    }
    written[item.action]++;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Backup and restore
// ---------------------------------------------------------------------------

/** Stable id of a repository checkout: its directory name plus a short path hash. */
export function repoId(repoRoot: string): string {
  const abs = path.resolve(repoRoot);
  const hash = createHash('sha1').update(abs).digest('hex').slice(0, 8);
  return `${path.basename(abs).replace(/[^A-Za-z0-9._-]/g, '_')}-${hash}`;
}

export function backupDirFor(repoRoot: string, home: string = os.homedir()): string {
  return path.join(home, '.ai-sdlc', 'board-backups', repoId(repoRoot));
}

export interface BackupResult {
  status: 'written' | 'skipped-today' | 'skipped-empty';
  file?: string;
  pruned: string[];
}

/**
 * Copy the board to `<backupDir>/<YYYY-MM-DD>.tar.gz` once a day and keep the newest
 * {@link BACKUPS_KEPT}. An empty board is not backed up, so a wiped board never replaces
 * a good copy.
 */
export function backupBoard(
  boardDir: string,
  backupDir: string,
  now: Date,
  keep: number = BACKUPS_KEPT,
): BackupResult {
  if (boardIsEmpty(boardDir)) return { status: 'skipped-empty', pruned: [] };
  const file = path.join(backupDir, `${now.toISOString().slice(0, 10)}.tar.gz`);
  if (existsSync(file)) return { status: 'skipped-today', file, pruned: [] };
  mkdirSync(backupDir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    execFileSync('tar', ['-czf', tmp, '-C', boardDir, '.'], { stdio: 'ignore', timeout: 60_000 });
    execFileSync('mv', [tmp, file]);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { status: 'written', file, pruned: rotateBackups(backupDir, keep) };
}

/** Delete all but the newest `keep` dated backups; returns the deleted file names. */
export function rotateBackups(backupDir: string, keep: number = BACKUPS_KEPT): string[] {
  if (!existsSync(backupDir)) return [];
  const dated = readdirSync(backupDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(f))
    .sort();
  const doomed = dated.slice(0, Math.max(0, dated.length - keep));
  for (const f of doomed) rmSync(path.join(backupDir, f), { force: true });
  return doomed;
}

/** Restore a backup into the board directory; refuses a non-empty board unless `force`. */
export function restoreBoard(backupFile: string, boardDir: string, force = false): void {
  if (!existsSync(backupFile)) throw new Error(`backup not found: ${backupFile}`);
  if (!force && !boardIsEmpty(boardDir)) {
    throw new Error(`the board at ${boardDir} is not empty; pass --force to extract over it`);
  }
  mkdirSync(boardDir, { recursive: true });
  execFileSync('tar', ['-xzf', backupFile, '-C', boardDir], { stdio: 'ignore', timeout: 60_000 });
}
