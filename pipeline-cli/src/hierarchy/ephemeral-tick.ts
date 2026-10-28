/**
 * The dispatch tick's ephemeral-executor steps (RFC-0059, AISDLC-1074).
 *
 * Order within a tick: record verdicts, down the executors that produced them, sweep
 * any executor still alive after its verdict, reap crashed ones through the stall path,
 * then spawn one executor per eligible claim up to the cap, so the cap frees before it
 * is consumed. A static roster entry (no `taskId`) is never touched here.
 */

import { collectVerdicts, peekQueueOrder } from '../dispatch/board.js';
import { readRosterChecked } from './roster.js';
import type { RosterEntry } from './types.js';
import { isSpawnedExecutorNameOf } from './validate.js';

/** An executor still alive this long after its verdict is downed by the sweep. */
export const EPHEMERAL_SWEEP_MS = 5 * 60 * 1000;

/** Operations the tick needs; the CLI wires them to `hierarchyDown` and `hierarchySpawn`. */
export interface EphemeralDeps {
  /** Downs one executor by roster name and removes its roster entry. */
  down: (name: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Spawns the executor of one task; throws when it cannot. */
  spawn: (taskId: string) => Promise<void>;
  /** Maximum number of live dynamic executors. */
  cap: () => number;
  /** Sweep delay; default {@link EPHEMERAL_SWEEP_MS}. */
  sweepMs?: number;
}

/** What the ephemeral steps did this tick. */
export interface EphemeralReport {
  downed: {
    name: string;
    taskId: string;
    why: 'verdict' | 'sweep';
    ok: boolean;
    reason?: string;
  }[];
  spawned: string[];
  spawnErrors: { taskId: string; error: string }[];
}

/** Dynamic (spawned) executors in the roster: a task id and a name derived from it. */
export function dynamicExecutors(boardDir: string): RosterEntry[] {
  try {
    return readRosterChecked(boardDir).roster.sessions.filter(
      (e) =>
        e.role === 'executor' &&
        e.taskId !== undefined &&
        isSpawnedExecutorNameOf(e.name, e.taskId),
    );
  } catch {
    return [];
  }
}

/** True when `worker` names a dynamic executor in the roster. */
export function isEphemeralWorker(boardDir: string, worker: string): boolean {
  return dynamicExecutors(boardDir).some((e) => e.name === worker);
}

async function downOne(
  deps: EphemeralDeps,
  entry: RosterEntry,
  why: 'verdict' | 'sweep',
  out: EphemeralReport,
): Promise<void> {
  let r: { ok: boolean; reason?: string };
  try {
    r = await deps.down(entry.name);
  } catch (err) {
    r = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  out.downed.push({
    name: entry.name,
    taskId: entry.taskId as string,
    why,
    ok: r.ok,
    ...(r.reason ? { reason: r.reason } : {}),
  });
}

/** Down the executor of each verdict recorded this tick (matched by task and roster name). */
export async function downRecordedExecutors(
  boardDir: string,
  deps: EphemeralDeps,
  recorded: readonly { workerId: string; taskId: string }[],
  out: EphemeralReport,
): Promise<void> {
  const live = dynamicExecutors(boardDir);
  for (const v of recorded) {
    const entry = live.find((e) => e.name === v.workerId && e.taskId === v.taskId.toUpperCase());
    if (entry) await downOne(deps, entry, 'verdict', out);
  }
}

/**
 * Down any executor still alive `sweepMs` after its task's verdict. A verdict older than
 * the executor's start belongs to an earlier attempt and is ignored.
 */
export async function sweepFinishedExecutors(
  boardDir: string,
  deps: EphemeralDeps,
  nowMs: number,
  out: EphemeralReport,
): Promise<void> {
  const live = dynamicExecutors(boardDir).filter(
    (e) => !out.downed.some((d) => d.name === e.name && d.ok),
  );
  if (live.length === 0) return;
  const verdicts = collectVerdicts(boardDir);
  const sweepMs = deps.sweepMs ?? EPHEMERAL_SWEEP_MS;
  for (const entry of live) {
    const startedAt = Date.parse(entry.startedAt);
    const finished = verdicts.some((v) => {
      const at = Date.parse(v.completedAt);
      return (
        v.taskId.toUpperCase() === entry.taskId &&
        Number.isFinite(at) &&
        (Number.isNaN(startedAt) || at >= startedAt) &&
        nowMs - at >= sweepMs
      );
    });
    if (finished) await downOne(deps, entry, 'sweep', out);
  }
}

/** Spawn one executor per eligible queued claim, up to the cap on live dynamic executors. */
export async function spawnForEligibleClaims(
  boardDir: string,
  deps: EphemeralDeps,
  now: () => Date,
  out: EphemeralReport,
): Promise<void> {
  const live = dynamicExecutors(boardDir);
  let slots = deps.cap() - live.length;
  if (slots <= 0) return;
  const liveTasks = new Set(live.map((e) => e.taskId));
  for (const { taskId } of peekQueueOrder(boardDir, now)) {
    if (slots <= 0) break;
    if (liveTasks.has(taskId.toUpperCase())) continue;
    try {
      await deps.spawn(taskId);
      out.spawned.push(taskId);
      slots -= 1;
    } catch (err) {
      out.spawnErrors.push({ taskId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
