/**
 * Watchdog for the scheduler's tick child (AISDLC-1255). The scheduler runs ticks single-flight,
 * so one hung tick would stop every later one. The running tick's `{pid, startedAt}` lives under
 * `tick` in `<board>/reconcile-scheduler.json`; a tick older than the stall limit is killed
 * (SIGTERM, then SIGKILL), a `tick-stalled` event is appended to `<board>/board-events.jsonl`
 * and the next tick may start.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const STATE_FILE = 'reconcile-scheduler.json';
const EVENTS_FILE = 'board-events.jsonl';

/** Grace between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 5000;

export interface TickRecord {
  pid: number;
  /** Epoch milliseconds the tick started. */
  startedAt: number;
}

function readState(boardDir: string): Record<string, unknown> {
  try {
    const s: unknown = JSON.parse(readFileSync(path.join(boardDir, STATE_FILE), 'utf-8'));
    return s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeState(boardDir: string, state: Record<string, unknown>): void {
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(path.join(boardDir, STATE_FILE), JSON.stringify(state) + '\n');
}

/** The recorded running tick, when there is one. */
export function readTickRecord(boardDir: string): TickRecord | undefined {
  const t = readState(boardDir)['tick'] as Partial<TickRecord> | undefined;
  return t && typeof t.pid === 'number' && typeof t.startedAt === 'number'
    ? { pid: t.pid, startedAt: t.startedAt }
    : undefined;
}

/** Record the running tick; the scheduler pid and other fields stay. */
export function writeTickRecord(boardDir: string, tick: TickRecord): void {
  writeState(boardDir, { ...readState(boardDir), tick });
}

/** Forget the running tick (only when it is still the recorded one). */
export function clearTickRecord(boardDir: string, pid?: number): void {
  const { tick, ...rest } = readState(boardDir);
  if (tick === undefined) return;
  if (pid !== undefined && (tick as Partial<TickRecord>).pid !== pid) return;
  writeState(boardDir, rest);
}

/**
 * Milliseconds after which a running tick counts as stalled: `AI_SDLC_TICK_STALL_MINUTES` when a
 * positive number, else twice the tick interval.
 */
export function tickStallMs(intervalMs: number, env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env['AI_SDLC_TICK_STALL_MINUTES']);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 2 * intervalMs;
}

export interface WatchdogDeps {
  boardDir: string;
  now: () => Date;
  stallMs: number;
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  /** Runs `fn` after `ms` (SIGKILL follow-up). */
  later?: (fn: () => void, ms: number) => void;
}

/**
 * What the watchdog found: `running` (a live tick within its limit), `reaped` (a stalled tick was
 * killed and recorded), or `idle` (nothing recorded, or the recorded tick is gone).
 */
export function checkRunningTick(deps: WatchdogDeps): 'running' | 'reaped' | 'idle' {
  const rec = readTickRecord(deps.boardDir);
  if (!rec) return 'idle';
  if (!deps.isAlive(rec.pid)) {
    clearTickRecord(deps.boardDir, rec.pid);
    return 'idle';
  }
  const ageMs = deps.now().getTime() - rec.startedAt;
  if (ageMs <= deps.stallMs) return 'running';
  const send = (sig: 'SIGTERM' | 'SIGKILL'): void => {
    try {
      deps.kill(rec.pid, sig);
    } catch {
      /* already gone */
    }
  };
  send('SIGTERM');
  const later = deps.later ?? ((fn, ms) => setTimeout(fn, ms).unref());
  later(() => {
    if (deps.isAlive(rec.pid)) send('SIGKILL');
  }, KILL_GRACE_MS);
  appendFileSync(
    path.join(deps.boardDir, EVENTS_FILE),
    JSON.stringify({
      event: 'tick-stalled',
      pid: rec.pid,
      startedAt: new Date(rec.startedAt).toISOString(),
      ageSec: Math.round(ageMs / 1000),
      at: deps.now().toISOString(),
    }) + '\n',
    'utf-8',
  );
  clearTickRecord(deps.boardDir, rec.pid);
  return 'reaped';
}
