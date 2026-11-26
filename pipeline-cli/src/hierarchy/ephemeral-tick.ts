/**
 * The dispatch tick's ephemeral-executor steps (RFC-0059, AISDLC-1074).
 *
 * Order within a tick: down every finished executor, reap orphaned sessions and crashed
 * claims, then spawn one executor per eligible claim up to the cap, so the cap frees before
 * it is consumed. A static roster entry (no `taskId`) is never touched here.
 *
 * AISDLC-1417: teardown has one owner, {@link downFinishedExecutors}. It is level-triggered
 * from durable facts (the roster, the verdict files, the inflight manifests) and runs on
 * every tick whatever the hold, budget-pacer hold or quota skip; those gate spawns and
 * claims only.
 */

import { collectVerdicts, peekQueueOrder } from '../dispatch/board.js';
import type { DispatchVerdict } from '../dispatch/types.js';
import { listInflight } from './inflight.js';
import { openPrHoldReason, type OpenPrState } from './open-pr-limit.js';
import { readRosterChecked } from './roster.js';
import type { RosterEntry } from './types.js';
import { isSpawnedExecutorNameOf } from './validate.js';

/** Operations the tick needs; the CLI wires them to `hierarchyDown` and `hierarchySpawn`. */
export interface EphemeralDeps {
  /** Downs one executor by roster name and removes its roster entry. */
  down: (name: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Spawns the executor of one task; throws when it cannot. */
  spawn: (taskId: string) => Promise<void>;
  /** Kills unrostered spawned-executor tmux sessions; returns the names reaped (AISDLC-1117). */
  reapOrphans?: () => string[];
  /** Maximum number of live dynamic executors, given how many are live now (the load headroom counts them). */
  cap: (live?: number) => number;
  /** Open task PRs and their limit (AISDLC-1189); absent means no limit. */
  openPrs?: () => OpenPrState;
}

/** What the ephemeral steps did this tick. */
export interface EphemeralReport {
  downed: {
    name: string;
    taskId: string;
    why: 'verdict' | 'surplus';
    ok: boolean;
    reason?: string;
  }[];
  spawned: string[];
  spawnErrors: { taskId: string; error: string }[];
  /** Orphaned tmux sessions the sweep killed (AISDLC-1117). */
  orphansReaped?: string[];
  /** Queued tasks no roster executor may claim; each is reported once, never spawned (AISDLC-1121). */
  unclaimable?: { taskId: string; reason: string }[];
  /** New-task entries held because open PRs are at the limit (AISDLC-1189); the reason names the PRs. */
  heldForOpenPrs?: { taskIds: string[]; reason: string };
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
  why: 'verdict' | 'surplus',
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

/**
 * The completion time of the newest verdict of `entry`'s task written at or after the
 * executor started, or undefined when it has none. A verdict older than the start belongs
 * to an earlier attempt and is ignored.
 */
export function finishedAt(
  entry: RosterEntry,
  verdicts: readonly DispatchVerdict[],
): number | undefined {
  const startedAt = Date.parse(entry.startedAt);
  let newest: number | undefined;
  for (const v of verdicts) {
    const at = Date.parse(v.completedAt);
    if (v.taskId.toUpperCase() !== entry.taskId || !Number.isFinite(at)) continue;
    if (!Number.isNaN(startedAt) && at < startedAt) continue;
    if (newest === undefined || at > newest) newest = at;
  }
  return newest;
}

/**
 * AISDLC-1417: the one teardown owner. Down every rostered dynamic executor whose task has a
 * verdict newer than its start and that holds no inflight claim (an `iterate-needed` verdict
 * keeps its claim, so its executor stays). Level-triggered: a down that fails this tick is
 * retried on the next. No grace delay: the verdict is the executor's last act.
 */
export async function downFinishedExecutors(
  boardDir: string,
  deps: EphemeralDeps,
  out: EphemeralReport,
): Promise<void> {
  const live = dynamicExecutors(boardDir);
  if (live.length === 0) return;
  const verdicts = collectVerdicts(boardDir);
  const inflight = listInflight(boardDir);
  for (const entry of live) {
    if (inflight.some((i) => i.workerId === entry.name || i.taskId === entry.taskId)) continue;
    if (finishedAt(entry, verdicts) !== undefined) await downOne(deps, entry, 'verdict', out);
  }
}

/** Reap tmux sessions named like a spawned executor that the roster does not know. */
export function reapOrphanSessions(deps: EphemeralDeps, out: EphemeralReport): void {
  if (!deps.reapOrphans) return;
  const reaped = deps.reapOrphans();
  if (reaped.length > 0) out.orphansReaped = reaped;
}

/** Unclaimable tasks already reported, so the reason is logged once per task. */
const reportedUnclaimable = new Set<string>();

/** Spawn one executor per eligible queued claim, up to the cap on live dynamic executors. */
export async function spawnForEligibleClaims(
  boardDir: string,
  deps: EphemeralDeps,
  now: () => Date,
  out: EphemeralReport,
): Promise<void> {
  const live = dynamicExecutors(boardDir);
  let slots = deps.cap(live.length) - live.length;
  if (slots <= 0) return;
  const liveTasks = new Set(live.map((e) => e.taskId));
  // AISDLC-1121: a spawned executor claims as an in-session agent; a task it cannot claim would
  // cost a session start for a refused claim, so it is skipped here and reported once.
  const claimable = peekQueueOrder(boardDir, now, 'in-session-agent');
  const claimableIds = new Set(claimable.map((q) => q.taskId));
  for (const { taskId } of peekQueueOrder(boardDir, now)) {
    if (claimableIds.has(taskId)) continue;
    const key = `${boardDir}|${taskId}`;
    if (reportedUnclaimable.has(key)) continue;
    reportedUnclaimable.add(key);
    (out.unclaimable ??= []).push({
      taskId,
      reason: 'its workerKind is not claimable by an in-session executor; not spawning',
    });
  }
  let atLimit: ReturnType<NonNullable<EphemeralDeps['openPrs']>> | undefined;
  try {
    const st = deps.openPrs?.();
    if (st?.atLimit) atLimit = st;
  } catch {
    /* an unreadable landing record must not stop the spawn step */
  }
  const heldIds: string[] = [];
  // AISDLC-1330: the claim allows one holder per sequence group, so start only the first queued
  // member of a group, and none when an executor already started for that group is unclaimed.
  const startedGroups = new Set<string>();
  for (const { taskId, sequenceGroup } of claimable) {
    if (sequenceGroup && liveTasks.has(taskId.toUpperCase())) startedGroups.add(sequenceGroup);
  }
  for (const { taskId, repair, sequenceGroup } of claimable) {
    if (slots <= 0) break;
    if (sequenceGroup && !liveTasks.has(taskId.toUpperCase()) && startedGroups.has(sequenceGroup)) {
      continue;
    }
    if (atLimit && !repair) {
      if (!liveTasks.has(taskId.toUpperCase())) heldIds.push(taskId);
      continue;
    }
    if (liveTasks.has(taskId.toUpperCase())) continue;
    try {
      await deps.spawn(taskId);
      out.spawned.push(taskId);
      slots -= 1;
      if (sequenceGroup) startedGroups.add(sequenceGroup);
    } catch (err) {
      out.spawnErrors.push({ taskId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (atLimit && heldIds.length > 0) {
    out.heldForOpenPrs = { taskIds: heldIds, reason: openPrHoldReason(atLimit, heldIds) };
  }
}

/**
 * AISDLC-1083: down the surplus above the cap, only executors named in `idle` (no inflight
 * task). Returns how many were downed.
 */
export async function downIdleSurplus(
  boardDir: string,
  deps: EphemeralDeps,
  idle: ReadonlySet<string>,
  out: EphemeralReport,
): Promise<number> {
  const live = dynamicExecutors(boardDir).filter(
    (e) => !out.downed.some((d) => d.name === e.name && d.ok),
  );
  let surplus = live.length - deps.cap(live.length);
  let n = 0;
  for (const entry of live) {
    if (surplus <= 0) break;
    if (!idle.has(entry.name)) continue;
    await downOne(deps, entry, 'surplus', out);
    surplus -= 1;
    n += 1;
  }
  return n;
}
