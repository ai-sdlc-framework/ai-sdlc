/**
 * The idle-with-claim check the dispatch tick runs on every wake (AISDLC-826, AISDLC-1218, AISDLC-1226).
 *
 * The pipeline (`next-step`) is the single writer of progress: it refreshes the claim's
 * `inflight/<task>.state.json` (step marker, `lastHeartbeat`, `phase`) at every step boundary. A claim is
 * idle-with-claim only when (a) its phase is `done` or `aborted` and no verdict was written, or (b) its
 * `lastHeartbeat` is older than `stallMs`; in both cases only when no live `next-step` runs under the
 * holder. The holder is cleared (which restarts its executor loop) and the task goes back to `queue/`
 * through `requeueFailed`. An executor whose pane exits is handled at once by `pane-exited` (AISDLC-1217).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  readHeartbeat,
  readInflightManifest,
  TASK_ID_RE,
  writeDiagnostic,
} from '../dispatch/board.js';
import { requeueFailed, snapshotFailedManifest } from '../dispatch/requeue.js';
import type { DispatchVerdict } from '../dispatch/types.js';
import { listInflight } from './inflight.js';
import { isOwnTaskBranch } from './playbook.js';
import type { CommandRunner } from './types.js';

/** Cause code written on the failure record of a reaped claim. */
export const IDLE_WITH_CLAIM_CAUSE = 'idle-with-claim';

/** One reaped claim, as reported on the tick result and the progress line. */
export interface StalledReport {
  taskId: string;
  worker: string;
  /** Age of the claim's last heartbeat write, in milliseconds (informational only). */
  ageMs: number;
  /** Step the executor last reported, or `unknown`. */
  step: string;
  /** Why the claim counted as stalled. */
  reason: 'idle-with-claim';
  /** Pull request that already existed for the task, when one was found. */
  prNumber?: number;
  clear?: { status: string; reason?: string };
  /** Whether the task went back to `queue/`, with the refusal reason when it did not. */
  requeue?: { status: 'requeued' | 'refused'; reason?: string };
  /** Path of the `failed/` diagnostic the reap wrote (relative to the board). */
  diagnostic: string;
}

/** Collaborators of {@link reapStalledClaims}. */
export interface StallDeps {
  boardDir: string;
  now: () => Date;
  /**
   * Whether the named executor has a live `next-step` descendant process (AISDLC-1198): a
   * backgrounded verification keeps the session idle while real work runs.
   */
  hasLiveNextStep?: (worker: string) => boolean;
  /** A claim whose heartbeat is older than this is stalled (AISDLC-1226). Default {@link DEFAULT_STALL_MS}. */
  stallMs?: number;
  /** Called when a claim that would be reaped is spared, with the reason. */
  onSpared?: (o: { taskId: string; worker: string; ageMs: number; reason: string }) => void;
  /** Clears (and so restarts) one executor; undefined when the grant is missing. */
  clear?: (o: { executor: string; taskId: string }) => Promise<{ status: string; reason?: string }>;
  /** Open pull request number of the task, when one exists. */
  findPr?: (taskId: string) => number | undefined;
}

/** Default stall window: the pipeline refreshes the heartbeat at every step boundary (AISDLC-1226). */
export const DEFAULT_STALL_MS = 20 * 60_000;

function hasVerdict(boardDir: string, taskId: string): boolean {
  return ['done', 'failed'].some((d) =>
    ['.verdict.json', '.completed.json', '.diagnostic.json'].some((s) =>
      existsSync(path.join(boardDir, d, `${taskId}${s}`)),
    ),
  );
}

function safeProbe(fn: (worker: string) => boolean, worker: string): boolean {
  try {
    return fn(worker);
  } catch {
    return false;
  }
}

/**
 * True when a process in the pane's tree (any depth) runs `next-step`, read from `ps` output
 * (`pid ppid command`). False when `ps` fails or the pane pid is unknown.
 */
export function paneHasLiveNextStep(run: CommandRunner, panePid: number): boolean {
  if (panePid <= 0) return false;
  const r = run('ps', ['-A', '-o', 'pid=,ppid=,command=']);
  if (r.status !== 0) return false;
  const procs: { pid: number; ppid: number; cmd: string }[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] ?? '' });
  }
  const seen = new Set<number>([panePid]);
  let level = [panePid];
  while (level.length > 0) {
    const next: number[] = [];
    for (const p of procs) {
      if (!level.includes(p.ppid) || seen.has(p.pid)) continue;
      if (/\bnext-step\b/.test(p.cmd)) return true;
      seen.add(p.pid);
      next.push(p.pid);
    }
    level = next;
  }
  return false;
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
  const nowMs = deps.now().getTime();
  const reports: StalledReport[] = [];
  for (const item of listInflight(deps.boardDir)) {
    const { taskId } = item;
    if (!TASK_ID_RE.test(taskId) || hasVerdict(deps.boardDir, taskId)) continue;
    const manifest = readInflightManifest(deps.boardDir, taskId);
    if (!manifest) continue;
    const heartbeat = readHeartbeat(deps.boardDir, taskId);
    const last = Date.parse(heartbeat?.lastHeartbeat ?? manifest.dispatchedAt);
    const ageMs = Number.isNaN(last) ? 0 : Math.max(0, nowMs - last);
    const worker = heartbeat?.workerId ?? manifest.workerId ?? 'unknown';
    const reason: StalledReport['reason'] = 'idle-with-claim';
    const terminal = heartbeat?.phase === 'done' || heartbeat?.phase === 'aborted';
    if (!terminal && ageMs <= (deps.stallMs ?? DEFAULT_STALL_MS)) continue;
    if (deps.hasLiveNextStep && worker !== 'unknown' && safeProbe(deps.hasLiveNextStep, worker)) {
      try {
        deps.onSpared?.({
          taskId,
          worker,
          ageMs,
          reason:
            'executor is idle but a live next-step process is running under it (backgrounded verification)',
        });
      } catch {
        /* reporting must not break the tick */
      }
      continue;
    }

    const step = heartbeat?.currentStep ?? 'unknown';
    snapshotFailedManifest(deps.boardDir, manifest);
    const verdict: DispatchVerdict = {
      schemaVersion: 'v1',
      taskId,
      outcome: 'failed',
      completedAt: deps.now().toISOString(),
      workerId: worker,
      cause: IDLE_WITH_CLAIM_CAUSE,
      notes: `executor idle with the claim and no verdict at step ${step} (no channel reaches an executor)`,
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
      diagnostic: `failed/${taskId}.diagnostic.json`,
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
    try {
      requeueFailed(deps.boardDir, taskId);
      report.requeue = { status: 'requeued' };
    } catch (err) {
      report.requeue = {
        status: 'refused',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    reports.push(report);
  }
  return reports;
}

/** One line for the dispatch progress report. */
export function formatStall(r: StalledReport): string {
  const head =
    `Reaped idle-with-claim ${r.taskId} (worker ${r.worker}, step ${r.step})` +
    (r.prNumber !== undefined ? `, pull request #${r.prNumber}` : '');
  if (r.requeue?.status === 'requeued') return `${head}; re-queued (DEC-0392)`;
  return (
    `${head}; not re-queued${r.requeue?.reason ? ` (${r.requeue.reason})` : ''}` +
    ` (DEC-0392), diagnostic ${r.diagnostic}`
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
