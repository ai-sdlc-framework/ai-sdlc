/**
 * The stall check the dispatch tick runs on every wake (AISDLC-826).
 *
 * An inflight claim is stalled when its heartbeat is older than the stale
 * threshold, or when its holder is idle on a question. An executor whose pane exits is
 * handled at once by `pane-exited` (AISDLC-1217), not here. A stalled claim moves to `failed/` with cause
 * `stale-worker`, the holder is cleared (which restarts its executor loop) and
 * the task re-enters (`reenter` when a pull request exists, else a requeue) with a note naming the step it stalled at and
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
  reason: 'stale-heartbeat' | 'holder-asked-question';
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
  /** Live state of each roster session by name; absent means no holder check. */
  liveness?: () => ReadonlyMap<string, LiveState>;
  /**
   * Whether the named executor's last output is a question (AISDLC-948). No channel
   * reaches an executor, so an idle holder that asked one waits forever: it is
   * stalled on the next tick, without the idle grace.
   */
  lastOutputIsQuestion?: (worker: string) => boolean;
  /**
   * Whether the named executor has a live `next-step` descendant process (AISDLC-1198): a
   * backgrounded verification keeps the session idle with an aging heartbeat while real work runs.
   */
  hasLiveNextStep?: (worker: string) => boolean;
  /** Called when a claim that would be reaped is spared, with the reason. */
  onSpared?: (o: { taskId: string; worker: string; ageMs: number; reason: string }) => void;
  /** Clears (and so restarts) one executor; undefined when the grant is missing. */
  clear?: (o: { executor: string; taskId: string }) => Promise<{ status: string; reason?: string }>;
  /**
   * Sends the reaped task back to an executor; undefined when the grant is missing. With
   * a pull request it is a `reenter` carrying the step note; without one, a plain requeue.
   */
  requeue?: (taskId: string, note: string, pr?: number) => void;
  /** Open pull request number of the task, when one exists. */
  findPr?: (taskId: string) => number | undefined;
}

/**
 * True when the last line of real output in a captured pane tail is a question.
 * Lines that are only terminal chrome (box drawing, the input prompt) are skipped.
 */
export function endsWithQuestion(paneTail: string): boolean {
  const lines = paneTail
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^[─━│┃╭╮╰╯┌┐└┘❯>⏵\s]/u.test(l));
  const last = lines[lines.length - 1];
  return last !== undefined && last.endsWith('?');
}

/** Read a positive millisecond value from the environment, else the default. */
export function stallThresholdsFromEnv(
  env: NodeJS.ProcessEnv,
  defaults: { staleMs: number } = { staleMs: DEFAULT_STALL_STALE_MS },
): {
  staleMs: number;
} {
  const read = (v: string | undefined, d: number): number => {
    const n = v === undefined ? Number.NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    staleMs: read(env.AI_SDLC_DISPATCH_STALE_MS, defaults.staleMs),
  };
}

function hasVerdict(boardDir: string, taskId: string): boolean {
  return ['done', 'failed'].some((d) =>
    ['.verdict.json', '.completed.json', '.diagnostic.json'].some((s) =>
      existsSync(path.join(boardDir, d, `${taskId}${s}`)),
    ),
  );
}

function safeIsQuestion(fn: (worker: string) => boolean, worker: string): boolean {
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
 * True when the stalled step is past implementation (numbered step 10 or later, or a named
 * review/ship step), so the resume continues from the pull request without a developer round.
 */
function developerDone(step: string): boolean {
  const n = /^(\d+)/.exec(step);
  if (n) return Number(n[1]) >= 10;
  return /^(review|ship|sign|signing|merge)/i.test(step);
}

/**
 * Build the resume note from the resume path it accompanies (AISDLC-1199): only a path that cannot
 * run the developer says so; an earlier step leaves a developer round open.
 */
export function stallResumeNote(step: string, prNumber?: number): string {
  const head = `The previous executor stalled at step ${step}. `;
  if (prNumber === undefined) {
    return head + 'No pull request exists yet; start from the task branch if it has commits.';
  }
  return (
    head +
    (developerDone(step)
      ? `Pull request #${prNumber} already exists; continue from it and do not re-run the developer.`
      : `Pull request #${prNumber} already exists; continue from it, and run the developer only if the work is incomplete or a review round requires it.`)
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
    if (ageMs > staleMs) {
      reason = 'stale-heartbeat';
    } else if (heartbeat?.workerId && deps.liveness) {
      live ??= deps.liveness();
      const state = live.get(heartbeat.workerId);
      if (
        state === 'idle' &&
        deps.lastOutputIsQuestion &&
        safeIsQuestion(deps.lastOutputIsQuestion, heartbeat.workerId)
      ) {
        reason = 'holder-asked-question';
      }
    }
    if (!reason) continue;
    if (
      reason !== 'holder-asked-question' &&
      deps.hasLiveNextStep &&
      worker !== 'unknown' &&
      safeIsQuestion(deps.hasLiveNextStep, worker)
    ) {
      try {
        deps.onSpared?.({
          taskId,
          worker,
          ageMs,
          reason: `heartbeat ${Math.round(ageMs / 1000)}s old but a live next-step process is running under the executor (backgrounded verification)`,
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
      cause: STALE_WORKER_CAUSE,
      notes:
        `stalled at step ${step}: heartbeat ${Math.round(ageMs / 1000)}s old` +
        (reason === 'holder-asked-question'
          ? ', holder idle on a question (no channel reaches an executor)'
          : ''),
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
        deps.requeue(taskId, stallResumeNote(step, pr), pr);
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
