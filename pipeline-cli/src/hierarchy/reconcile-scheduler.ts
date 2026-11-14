/**
 * Lifecycle of the detached reconcile scheduler (`cli-dispatch reconcile --watch`,
 * RFC-0054, AISDLC-932): `cli-hierarchy up` starts it, `down` stops it, `status`
 * reports it. The pid lives in `<board>/reconcile-scheduler.json`.
 */

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { hostStallMs, lastTickInfo } from './host-liveness.js';
import { peekQueue } from '../dispatch/board.js';
import { reconcileLogPath } from './pr-rows.js';
import { readTickRecord } from './tick-watchdog.js';
import type { HierarchyDeps } from './types.js';

const STATE_FILE = 'reconcile-scheduler.json';

/** What `status` reports about the scheduler. */
export type SchedulerStatus =
  { state: 'up'; pid: number; stalled?: { ageSec: number } } | { state: 'off' };

/** Starts a detached process and returns its pid (undefined when it has none). */
export type PidSpawner = (
  file: string,
  args: readonly string[],
  logFile?: string,
) => number | undefined;

/** AISDLC-1095: stdout and stderr go to `logFile` so the scheduler leaves a record. */
const spawnDetached: PidSpawner = (file, args, logFile) => {
  let fd: number | undefined;
  if (logFile !== undefined) {
    mkdirSync(path.dirname(logFile), { recursive: true });
    fd = openSync(logFile, 'a');
  }
  const child = spawn(file, [...args], {
    detached: true,
    stdio: fd === undefined ? 'ignore' : ['ignore', fd, fd],
  });
  child.unref();
  if (fd !== undefined) closeSync(fd);
  return child.pid;
};

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const stateFile = (boardDir: string): string => path.join(boardDir, STATE_FILE);

function readPid(boardDir: string): number | undefined {
  try {
    const s = JSON.parse(readFileSync(stateFile(boardDir), 'utf-8')) as { pid?: unknown };
    return typeof s.pid === 'number' ? s.pid : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a live scheduler is recorded. */
export function schedulerStatus(deps: HierarchyDeps): SchedulerStatus {
  const pid = readPid(deps.boardDir);
  if (pid === undefined || !(deps.isAlive ?? defaultIsAlive)(pid)) return { state: 'off' };
  // AISDLC-1255: stuck = a live tick running past the stall limit, or work queued while the last
  // tick is older than the limit. An idle scheduler with an empty queue is healthy.
  const limitMs = hostStallMs(undefined, deps.env);
  const now = deps.now().getTime();
  const last = lastTickInfo(deps.boardDir, deps.now());
  const rec = readTickRecord(deps.boardDir);
  const running =
    rec !== undefined && now - rec.startedAt > limitMs && (deps.isAlive ?? defaultIsAlive)(rec.pid);
  const queuedStale =
    last !== undefined && last.ageSec * 1000 > limitMs && peekQueue(deps.boardDir).queued > 0;
  if (running || queuedStale) {
    const ageSec = last?.ageSec ?? Math.round((now - (rec?.startedAt ?? now)) / 1000);
    return { state: 'up', pid, stalled: { ageSec } };
  }
  return { state: 'up', pid };
}

/** The status line, `scheduler: up (pid N)` or `scheduler: off`. */
export function formatSchedulerStatus(s: SchedulerStatus): string {
  if (s.state === 'off') return 'scheduler: off';
  return s.stalled
    ? `scheduler: STALLED (last tick ${s.stalled.ageSec}s ago, pid ${s.pid})`
    : `scheduler: up (pid ${s.pid})`;
}

/** Start the scheduler detached and record its pid; a live one is left alone. */
export function schedulerUp(
  deps: HierarchyDeps,
  spawner: PidSpawner = spawnDetached,
): SchedulerStatus {
  const before = schedulerStatus(deps);
  if (before.state === 'up') {
    deps.log(`scheduler already running (pid ${before.pid})`);
    return before;
  }
  const hierarchyBin = deps.binPath ?? process.argv[1] ?? '';
  const pid = spawner(
    process.execPath,
    [
      path.join(path.dirname(hierarchyBin), 'cli-dispatch.mjs'),
      'reconcile',
      '--watch',
      '--board-dir',
      deps.boardDir,
    ],
    reconcileLogPath(deps.boardDir),
  );
  if (pid === undefined) throw new Error('could not start the reconcile scheduler');
  mkdirSync(deps.boardDir, { recursive: true });
  writeFileSync(stateFile(deps.boardDir), JSON.stringify({ pid }) + '\n');
  deps.log(`scheduler starting (pid ${pid})`);
  return { state: 'up', pid };
}

/** Stop a recorded scheduler. Returns true when a record existed. */
export function schedulerDown(
  deps: HierarchyDeps,
  kill: (pid: number) => void = (pid) => process.kill(pid, 'SIGTERM'),
): boolean {
  const pid = readPid(deps.boardDir);
  if (pid === undefined) return false;
  if ((deps.isAlive ?? defaultIsAlive)(pid)) {
    try {
      kill(pid);
    } catch {
      /* already gone */
    }
  }
  rmSync(stateFile(deps.boardDir), { force: true });
  deps.log(`scheduler stopped (pid ${pid})`);
  return true;
}
