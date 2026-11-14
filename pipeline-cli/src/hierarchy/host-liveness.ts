/**
 * Dispatch-host liveness (AISDLC-1096). The tick lives in the dispatch host's module;
 * when the host is absent nothing ticks and nothing says so. `runDispatchTick` records
 * `lastTickAt`; the watch scheduler runs the same deterministic tick (never a model
 * turn) when the host has missed three intervals and work is queued, and `status`
 * shows the age and who ticked.
 */

import process from 'node:process';

import { readLoopState } from './dispatch-loop.js';
import { peekQueue } from '../dispatch/board.js';
import {
  checkRunningTick,
  clearTickRecord,
  tickStallMs,
  writeTickRecord,
  type WatchdogDeps,
} from './tick-watchdog.js';

/** The host's tick interval (mirrors `DEFAULT_TICK_MS` in the dispatch hook). */
export const HOST_TICK_INTERVAL_MS = 30_000;
/** Missed intervals before the scheduler steps in. */
export const MISSED_TICKS = 3;

/** True when the host has not ticked for {@link MISSED_TICKS} intervals (or never). */
export function hostTickStale(boardDir: string, now: Date): boolean {
  const last = readLoopState(boardDir).lastTickAt;
  const at = last ? Date.parse(last) : Number.NaN;
  return !Number.isFinite(at) || now.getTime() - at >= MISSED_TICKS * HOST_TICK_INTERVAL_MS;
}

/** The last tick for `status`; undefined when no tick was recorded. */
export function lastTickInfo(
  boardDir: string,
  now: Date,
): { ageSec: number; by: 'host' | 'scheduler' } | undefined {
  const s = readLoopState(boardDir);
  const at = s.lastTickAt ? Date.parse(s.lastTickAt) : Number.NaN;
  if (!Number.isFinite(at)) return undefined;
  return {
    ageSec: Math.max(0, Math.round((now.getTime() - at) / 1000)),
    by: s.lastTickBy === 'scheduler' ? 'scheduler' : 'host',
  };
}

/** The status line, `last tick: 45s ago by host`. */
export function formatLastTick(
  t: { ageSec: number; by: 'host' | 'scheduler' } | undefined,
): string {
  return t ? `last tick: ${t.ageSec}s ago by ${t.by}` : 'last tick: never';
}

export interface HostWatchDeps {
  boardDir: string;
  now: () => Date;
  /**
   * Starts one tick as the scheduler (the scheduler never calls it while the host is alive). A tick
   * started without waiting returns its pid and calls `onExit` when it ends, so the watchdog can
   * track it (AISDLC-1255).
   */
  runTick: (onExit: () => void) => number | void;
  intervalMs?: number;
  /** Process table for the watchdog (tests). */
  watchdog?: Pick<WatchdogDeps, 'isAlive' | 'kill' | 'later'>;
  /** Stall limit override (tests); default {@link tickStallMs}. */
  stallMs?: number;
}

const defaultWatchdog: Pick<WatchdogDeps, 'isAlive' | 'kill'> = {
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  kill: (pid, signal) => {
    try {
      process.kill(-pid, signal);
    } catch {
      process.kill(pid, signal);
    }
  },
};

/** One check: tick when the host is silent and work is queued. Returns whether it ticked. */
export function hostWatchCheck(deps: HostWatchDeps): boolean {
  // A live tick within its limit keeps the scheduler single-flight; a stalled one is killed and
  // replaced (AISDLC-1255).
  const running = checkRunningTick({
    boardDir: deps.boardDir,
    now: deps.now,
    stallMs: deps.stallMs ?? tickStallMs(deps.intervalMs ?? HOST_TICK_INTERVAL_MS),
    ...defaultWatchdog,
    ...deps.watchdog,
  });
  if (running === 'running') return false;
  if (!hostTickStale(deps.boardDir, deps.now())) return false;
  if (peekQueue(deps.boardDir).queued === 0) return false;
  try {
    const started = deps.now().getTime();
    const pid: number | void = deps.runTick(() => {
      if (typeof pid === 'number') clearTickRecord(deps.boardDir, pid);
    });
    if (typeof pid === 'number') writeTickRecord(deps.boardDir, { pid, startedAt: started });
  } catch {
    /* retried at the next check */
  }
  return true;
}

/** Check on an interval until stopped. */
export function startHostWatch(deps: HostWatchDeps): { stop(): void } {
  const timer = setInterval(() => hostWatchCheck(deps), deps.intervalMs ?? HOST_TICK_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
