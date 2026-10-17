/**
 * Lifecycle of the detached reconcile scheduler (`cli-dispatch reconcile --watch`,
 * RFC-0054, AISDLC-932): `cli-hierarchy up` starts it, `down` stops it, `status`
 * reports it. The pid lives in `<board>/reconcile-scheduler.json`.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import type { HierarchyDeps } from './types.js';

const STATE_FILE = 'reconcile-scheduler.json';

/** What `status` reports about the scheduler. */
export type SchedulerStatus = { state: 'up'; pid: number } | { state: 'off' };

/** Starts a detached process and returns its pid (undefined when it has none). */
export type PidSpawner = (file: string, args: readonly string[]) => number | undefined;

const spawnDetached: PidSpawner = (file, args) => {
  const child = spawn(file, [...args], { detached: true, stdio: 'ignore' });
  child.unref();
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
  return pid !== undefined && (deps.isAlive ?? defaultIsAlive)(pid)
    ? { state: 'up', pid }
    : { state: 'off' };
}

/** The status line, `scheduler: up (pid N)` or `scheduler: off`. */
export function formatSchedulerStatus(s: SchedulerStatus): string {
  return s.state === 'up' ? `scheduler: up (pid ${s.pid})` : 'scheduler: off';
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
  const pid = spawner(process.execPath, [
    path.join(path.dirname(hierarchyBin), 'cli-dispatch.mjs'),
    'reconcile',
    '--watch',
    '--board-dir',
    deps.boardDir,
  ]);
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
