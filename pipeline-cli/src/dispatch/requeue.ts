/**
 * Re-queue a failed task by id.
 *
 * `writeVerdict` removes a task's inflight manifest when the task fails, so the
 * information needed to run it again (branch, base commit, ordering, retry
 * count) would be lost. `snapshotFailedManifest` keeps a copy next to the
 * failure record at completion time; `requeueFailed` restores it to `queue/`
 * with the retry count incremented.
 *
 * `requeueFailed` checks everything before it writes anything: a refusal leaves
 * the board exactly as it was.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ensureBoardDirs, TASK_ID_RE, writeManifest } from './board.js';
import { DEFAULT_REQUEUE_RETRY_LIMIT } from './session-reaper.js';
import type { DispatchManifest } from './types.js';

/** Filename suffix of the manifest copy kept in `failed/`. */
export const FAILED_MANIFEST_SUFFIX = '.manifest.json';
const FAILURE_SUFFIXES = ['.verdict.json', '.diagnostic.json'] as const;
const ACTIVE_DIRS = ['queue', 'inflight', 'blocked'] as const;

function assertId(taskId: string): void {
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
    throw new Error(`'${String(taskId)}' is not a valid task id`);
  }
}

/**
 * Keep a copy of a manifest in `failed/` so the task can be queued again.
 * Called before the failure verdict is written, while the inflight manifest
 * still exists. The write is atomic (a temp file in the same directory, then a
 * rename), so the copy is either complete or absent. A task with no copy is never
 * re-queued from a guess: `requeueFailed` refuses it and the playbook escalates.
 */
export function snapshotFailedManifest(boardDir: string, manifest: DispatchManifest): string {
  assertId(manifest.taskId);
  ensureBoardDirs(boardDir);
  const target = path.join(boardDir, 'failed', `${manifest.taskId}${FAILED_MANIFEST_SUFFIX}`);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    renameSync(tmp, target);
  } catch (err) {
    // Never leave a partial copy behind: a later requeue must see all or nothing.
    rmSync(tmp, { force: true });
    throw err;
  }
  return target;
}

/** Result of a successful re-queue. */
export interface RequeueFailedResult {
  taskId: string;
  /** Retry count now recorded on the queued manifest. */
  retryCount: number;
  queuePath: string;
}

/** Options for {@link requeueFailed}. */
export interface RequeueFailedOptions {
  /** Re-queues allowed per task (default {@link DEFAULT_REQUEUE_RETRY_LIMIT}). */
  retryLimit?: number;
}

function readSnapshot(file: string): DispatchManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as DispatchManifest;
    return parsed && typeof parsed === 'object' && typeof parsed.taskId === 'string'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Return a failed task to `queue/`.
 * @throws, writing nothing, when the id is malformed, the task has no failure
 *   record in `failed/`, no manifest copy was kept, the task is already queued,
 *   inflight or blocked, or one more re-queue would pass the retry limit.
 */
export function requeueFailed(
  boardDir: string,
  taskId: string,
  opts: RequeueFailedOptions = {},
): RequeueFailedResult {
  assertId(taskId);
  const retryLimit = opts.retryLimit ?? DEFAULT_REQUEUE_RETRY_LIMIT;
  const failedDir = path.join(boardDir, 'failed');
  const records = FAILURE_SUFFIXES.map((s) => path.join(failedDir, `${taskId}${s}`)).filter((f) =>
    existsSync(f),
  );
  if (records.length === 0) {
    throw new Error(`${taskId} is not in failed/; only a failed task can be re-queued`);
  }
  for (const sub of ACTIVE_DIRS) {
    if (existsSync(path.join(boardDir, sub, `${taskId}.dispatch.json`))) {
      throw new Error(`${taskId} is already in ${sub}/`);
    }
  }
  const snapshotFile = path.join(failedDir, `${taskId}${FAILED_MANIFEST_SUFFIX}`);
  const manifest = existsSync(snapshotFile) ? readSnapshot(snapshotFile) : undefined;
  if (!manifest || manifest.taskId !== taskId) {
    throw new Error(`${taskId} has no saved manifest in failed/, so it cannot be re-queued`);
  }
  const prior =
    Number.isInteger(manifest.retryCount) && (manifest.retryCount as number) > 0
      ? (manifest.retryCount as number)
      : 0;
  const retryCount = prior + 1;
  if (retryCount > retryLimit) {
    throw new Error(
      `${taskId} has already been re-queued ${prior} time(s); the limit is ${retryLimit}`,
    );
  }

  const next: DispatchManifest = { ...manifest, retryCount };
  delete next.workerId;
  delete next.blockedBy;
  const queuePath = writeManifest(boardDir, next);
  for (const f of [...records, snapshotFile]) rmSync(f, { force: true });
  return { taskId, retryCount, queuePath };
}
