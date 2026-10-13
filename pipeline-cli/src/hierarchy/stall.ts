/**
 * The stall check the dispatch tick runs on every wake (AISDLC-826).
 *
 * An inflight claim is stalled when its heartbeat is older than the stale
 * threshold, or when the session holding it is `idle`, `gone` or `unknown` and
 * its heartbeat is older than a short grace (the executor ended its turn
 * without writing a verdict). A stalled claim moves to `failed/` with cause
 * `stale-worker`, the holder is cleared (which restarts its executor loop) and
 * the task is re-queued with a resume note naming the step it stalled at and
 * any pull request that already exists. This is operational: the planner is
 * never asked.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  readHeartbeat,
  readInflightManifest,
  TASK_ID_RE,
  writeDiagnostic,
} from '../dispatch/board.js';
import { snapshotFailedManifest } from '../dispatch/requeue.js';
import type { DispatchVerdict } from '../dispatch/types.js';
import { listInflight } from './inflight.js';
import { isOwnTaskBranch } from './playbook.js';
import type { LiveState } from './status.js';
import type { CommandRunner } from './types.js';

/** Heartbeat age after which a claim is stalled (RFC-0041 OQ-3). */
export const DEFAULT_STALL_STALE_MS = 30 * 60 * 1000;
/** Heartbeat age after which a claim whose holder is not busy is stalled. */
export const DEFAULT_STALL_GRACE_MS = 10 * 60 * 1000;
/** Cause code written on the failure record of a reaped claim. */
export const STALE_WORKER_CAUSE = 'stale-worker';

/** One reaped claim, as reported on the tick result and the progress line. */
export interface StalledReport {
  taskId: string;
  worker: string;
  /** Age of the last heartbeat, in milliseconds. */
  ageMs: number;
  /** Step the executor last reported, or `unknown`. */
  step: string;
  /** Why the claim counted as stalled. */
  reason: 'stale-heartbeat' | 'holder-not-busy';
  /** Pull request that already existed for the task, when one was found. */
  prNumber?: number;
  clear?: { status: string; reason?: string };
  requeue: { done: boolean; reason?: string };
}

/** Collaborators of {@link reapStalledClaims}. */
export interface StallDeps {
  boardDir: string;
  now: () => Date;
  staleMs?: number;
  graceMs?: number;
  /** Live state of each roster session by name; absent means no holder check. */
  liveness?: () => ReadonlyMap<string, LiveState>;
  /** Clears (and so restarts) one executor; undefined when the grant is missing. */
  clear?: (o: { executor: string; taskId: string }) => Promise<{ status: string; reason?: string }>;
  /** Re-queues a failed task with a resume note; undefined when the grant is missing. */
  requeue?: (taskId: string, note: string) => void;
  /** Open pull request number of the task, when one exists. */
  findPr?: (taskId: string) => number | undefined;
}

/** Read a positive millisecond value from the environment, else the default. */
export function stallThresholdsFromEnv(env: NodeJS.ProcessEnv): {
  staleMs: number;
  graceMs: number;
} {
  const read = (v: string | undefined, d: number): number => {
    const n = v === undefined ? Number.NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    staleMs: read(env.AI_SDLC_DISPATCH_STALE_MS, DEFAULT_STALL_STALE_MS),
    graceMs: read(env.AI_SDLC_DISPATCH_STALL_GRACE_MS, DEFAULT_STALL_GRACE_MS),
  };
}

function hasVerdict(boardDir: string, taskId: string): boolean {
  return ['done', 'failed'].some((d) =>
    ['.verdict.json', '.completed.json', '.diagnostic.json'].some((s) =>
      existsSync(path.join(boardDir, d, `${taskId}${s}`)),
    ),
  );
}

/** Build the resume note: the stalled step and the existing pull request. */
export function stallResumeNote(step: string, prNumber?: number): string {
  return (
    `The previous executor stalled at step ${step}. ` +
    (prNumber !== undefined
      ? `Pull request #${prNumber} already exists; continue from it and do not re-run the developer.`
      : 'No pull request exists yet; start from the task branch if it has commits.')
  );
}

/**
 * Check every inflight claim once. Returns the claims reaped. A claim is
 * removed from `inflight/` before anything else is done, so a later tick never
 * sees it again and a holder is never cleared twice.
 * @param onReaped called with the failure record's key before the holder is cleared
 */
export async function reapStalledClaims(
  deps: StallDeps,
  onReaped: (verdict: DispatchVerdict) => void = () => {},
): Promise<StalledReport[]> {
  const staleMs = deps.staleMs ?? DEFAULT_STALL_STALE_MS;
  const graceMs = deps.graceMs ?? DEFAULT_STALL_GRACE_MS;
  const nowMs = deps.now().getTime();
  const reports: StalledReport[] = [];
  let live: ReadonlyMap<string, LiveState> | undefined;
  for (const item of listInflight(deps.boardDir)) {
    const { taskId } = item;
    if (!TASK_ID_RE.test(taskId) || hasVerdict(deps.boardDir, taskId)) continue;
    const manifest = readInflightManifest(deps.boardDir, taskId);
    if (!manifest) continue;
    const heartbeat = readHeartbeat(deps.boardDir, taskId);
    const last = Date.parse(heartbeat?.lastHeartbeat ?? manifest.dispatchedAt);
    if (Number.isNaN(last)) continue;
    const ageMs = Math.max(0, nowMs - last);
    const worker = heartbeat?.workerId ?? 'unknown';
    let reason: StalledReport['reason'] | undefined;
    if (ageMs > staleMs) reason = 'stale-heartbeat';
    else if (ageMs > graceMs && heartbeat?.workerId && deps.liveness) {
      live ??= deps.liveness();
      const state = live.get(heartbeat.workerId);
      if (state === 'idle' || state === 'gone' || state === 'unknown') reason = 'holder-not-busy';
    }
    if (!reason) continue;

    const step = heartbeat?.currentStep ?? 'unknown';
    snapshotFailedManifest(deps.boardDir, manifest);
    const verdict: DispatchVerdict = {
      schemaVersion: 'v1',
      taskId,
      outcome: 'failed',
      completedAt: deps.now().toISOString(),
      workerId: worker,
      cause: STALE_WORKER_CAUSE,
      notes:
        `stalled at step ${step}: heartbeat ${Math.round(ageMs / 1000)}s old` +
        (reason === 'holder-not-busy' ? ', holder session not busy' : ''),
      lastStep: step,
      heartbeatAgeMs: ageMs,
    };
    if (heartbeat?.workerKind) verdict.workerKind = heartbeat.workerKind;
    writeDiagnostic(deps.boardDir, verdict);
    onReaped(verdict);

    const report: StalledReport = {
      taskId,
      worker,
      ageMs,
      step,
      reason,
      requeue: { done: false },
    };
    if (worker !== 'unknown' && deps.clear) {
      try {
        report.clear = await deps.clear({ executor: worker, taskId });
      } catch (err) {
        report.clear = {
          status: 'refused',
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
    let pr: number | undefined;
    try {
      pr = deps.findPr?.(taskId);
    } catch {
      pr = undefined;
    }
    if (pr !== undefined) report.prNumber = pr;
    if (deps.requeue) {
      try {
        deps.requeue(taskId, stallResumeNote(step, pr));
        report.requeue = { done: true };
      } catch (err) {
        report.requeue = {
          done: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      report.requeue = { done: false, reason: 'requeue is not granted' };
    }
    reports.push(report);
  }
  return reports;
}

/** One line for the dispatch progress report. */
export function formatStall(r: StalledReport): string {
  const min = Math.round(r.ageMs / 60000);
  return (
    `Reaped stalled ${r.taskId} (worker ${r.worker}, heartbeat ${min} min old, step ${r.step})` +
    (r.requeue.done ? ', re-queued' : `, not re-queued (${r.requeue.reason ?? 'unknown'})`)
  );
}

/** Number of the open pull request on the task's own branch, or undefined. */
export function findOpenPrNumber(
  run: CommandRunner,
  repoRoot: string,
  taskId: string,
): number | undefined {
  const r = run('gh', ['pr', 'list', '--state', 'open', '--json', 'number,headRefName'], {
    cwd: repoRoot,
  });
  if (r.status !== 0) return undefined;
  try {
    const list = JSON.parse(r.stdout) as { number: number; headRefName: string }[];
    return list.find((p) => isOwnTaskBranch(p.headRefName, taskId))?.number;
  } catch {
    return undefined;
  }
}
