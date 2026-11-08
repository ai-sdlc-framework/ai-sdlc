/**
 * Landing retires a failed verdict (AISDLC-1158).
 *
 * The verdict an executor wrote is a step record; landing is the only trigger for done. When a PR
 * lands for a task whose last verdict sits in `failed/` (a hand repair, a landing-lane merge), the
 * verdict and its manifest move to `done/` so the board never counts a landed task as failed. The
 * original failed verdict is kept inside the done record.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TASK_ID_RE } from './board.js';
import { DOCS_BRANCH_PREFIXES } from '../hierarchy/reconcile.js';

const VERDICT_SUFFIX = '.verdict.json';
const MANIFEST_SUFFIX = '.manifest.json';

export interface RetireLandedInput {
  taskId: string;
  /** ISO-8601 time the PR landed. */
  landedAt: string;
  /** Commit that landed, when known. */
  landedSha?: string;
  prNumber?: number;
  /** Head branch of the landed PR, when known (AISDLC-1177). */
  headBranch?: string;
  /** Landing-record kind of the landed PR, when known; anything but `task` is not a code PR. */
  kind?: string;
}

/**
 * Move the failed verdict and manifest of a landed task to `done/`.
 * @returns true when a failed verdict was retired; false when there was nothing to do
 *   (no failed verdict, or a verdict already in `done/`). Idempotent.
 */
export function retireFailedVerdict(boardDir: string, input: RetireLandedInput): boolean {
  if (!TASK_ID_RE.test(input.taskId)) return false;
  const failedVerdict = path.join(boardDir, 'failed', `${input.taskId}${VERDICT_SUFFIX}`);
  const doneVerdict = path.join(boardDir, 'done', `${input.taskId}${VERDICT_SUFFIX}`);
  if (!existsSync(failedVerdict) || existsSync(doneVerdict)) return false;
  let original: Record<string, unknown>;
  try {
    original = JSON.parse(readFileSync(failedVerdict, 'utf-8')) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (original['outcome'] === 'success') return false;
  // AISDLC-1177: only the task's own code PR retires its verdict.
  const verdictPr = original['prNumber'];
  if (typeof verdictPr === 'number') {
    if (input.prNumber !== undefined && input.prNumber !== verdictPr) return false;
  } else if (
    (input.kind !== undefined && input.kind !== 'task') ||
    DOCS_BRANCH_PREFIXES.some((p) => (input.headBranch ?? '').startsWith(p))
  ) {
    return false;
  }
  const record: Record<string, unknown> = {
    ...original,
    outcome: 'success',
    landed: input.landedAt,
    landedAt: input.landedAt,
    ...(input.landedSha === undefined ? {} : { landedSha: input.landedSha }),
    ...(input.prNumber === undefined || original['prNumber'] !== undefined
      ? {}
      : { prNumber: input.prNumber }),
    supersededCause: original['cause'] ?? original['outcome'] ?? 'failed',
    supersededVerdict: original,
  };
  delete record['cause'];
  const tmp = `${doneVerdict}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf-8');
    renameSync(tmp, doneVerdict);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  rmSync(failedVerdict, { force: true });
  const failedManifest = path.join(boardDir, 'failed', `${input.taskId}${MANIFEST_SUFFIX}`);
  const doneManifest = path.join(boardDir, 'done', `${input.taskId}${MANIFEST_SUFFIX}`);
  if (existsSync(failedManifest)) {
    if (existsSync(doneManifest)) rmSync(failedManifest, { force: true });
    else renameSync(failedManifest, doneManifest);
  }
  return true;
}

/**
 * Move the parked manifest of a landed task from `blocked/` to `done/` (AISDLC-1204), recording the
 * landing in a success verdict so the task is never requeued. Idempotent; same PR and kind guards
 * as {@link retireFailedVerdict}.
 * @returns true when a blocked manifest was retired.
 */
export function retireBlockedManifest(boardDir: string, input: RetireLandedInput): boolean {
  if (!TASK_ID_RE.test(input.taskId)) return false;
  const blocked = path.join(boardDir, 'blocked', `${input.taskId}${MANIFEST_SUFFIX}`);
  const doneVerdict = path.join(boardDir, 'done', `${input.taskId}${VERDICT_SUFFIX}`);
  if (!existsSync(blocked) || existsSync(doneVerdict)) return false;
  if (
    (input.kind !== undefined && input.kind !== 'task') ||
    DOCS_BRANCH_PREFIXES.some((p) => (input.headBranch ?? '').startsWith(p))
  ) {
    return false;
  }
  const record: Record<string, unknown> = {
    schemaVersion: 'v1',
    taskId: input.taskId,
    outcome: 'success',
    completedAt: input.landedAt,
    landed: input.landedAt,
    landedAt: input.landedAt,
    ...(input.landedSha === undefined ? {} : { landedSha: input.landedSha }),
    ...(input.prNumber === undefined ? {} : { prNumber: input.prNumber }),
    notes: 'retired from blocked/ because its PR landed',
  };
  const tmp = `${doneVerdict}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf-8');
    renameSync(tmp, doneVerdict);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  const doneManifest = path.join(boardDir, 'done', `${input.taskId}${MANIFEST_SUFFIX}`);
  if (existsSync(doneManifest)) rmSync(blocked, { force: true });
  else renameSync(blocked, doneManifest);
  return true;
}

/** The fields of a landing record the sweep reads. */
export interface LandedRecordLike {
  pr: number;
  taskId?: string;
  kind?: string;
  headBranch?: string;
  landed?: string;
  landedSha?: string;
  headSha?: string;
}

export interface RetireLandedReport {
  moved: { taskId: string; pr: number }[];
}

/** Apply `retireFailedVerdict` to every landed record on the board (the one-off sweep). */
export function retireLandedSweep(
  boardDir: string,
  records: readonly LandedRecordLike[],
): RetireLandedReport {
  const moved: RetireLandedReport['moved'] = [];
  for (const r of records) {
    if (!r.landed || !r.taskId) continue;
    const did = retireFailedVerdict(boardDir, {
      taskId: r.taskId,
      landedAt: r.landed,
      ...(r.landedSha ? { landedSha: r.landedSha } : r.headSha ? { landedSha: r.headSha } : {}),
      prNumber: r.pr,
      ...(r.kind ? { kind: r.kind } : {}),
      ...(r.headBranch ? { headBranch: r.headBranch } : {}),
    });
    const sha = r.landedSha ?? r.headSha;
    const didBlocked = retireBlockedManifest(boardDir, {
      taskId: r.taskId,
      landedAt: r.landed,
      ...(sha ? { landedSha: sha } : {}),
      prNumber: r.pr,
      ...(r.kind ? { kind: r.kind } : {}),
      ...(r.headBranch ? { headBranch: r.headBranch } : {}),
    });
    if (did || didBlocked) moved.push({ taskId: r.taskId, pr: r.pr });
  }
  return { moved };
}
