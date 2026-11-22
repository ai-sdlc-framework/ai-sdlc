/**
 * Board-wide slots for machine verify runs (AISDLC-1087).
 *
 * At most `VERIFY_SLOT_COUNT` executors run a verify suite at once; the rest wait. A slot is a
 * directory `<boardDir>/verify-slots/slot-<n>/` created with atomic mkdir and holding a `pid`
 * file. A slot whose pid is dead is reclaimed by the next caller; a live holder never is.
 * While another slot is held, the run gets a lower vitest worker ceiling so the host is not
 * oversubscribed.
 *
 * @module runtime/verify-slots
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const VERIFY_SLOT_COUNT = 2;
export const VERIFY_WORKERS_ALONE = 4;
export const VERIFY_WORKERS_SHARED = 2;
export const VERIFY_SLOT_POLL_MS = 500;

export interface VerifySlot {
  /** Slot index. */
  index: number;
  /** Worker ceiling for this run, from how many slots were held when it was acquired. */
  workers: number;
  release(): void;
}

export interface VerifySlotOptions {
  /**
   * A full-scope run (AISDLC-1378): waits until no other verify holds a slot, and blocks new
   * acquirers while it runs, so at most one full suite runs per machine.
   */
  exclusive?: boolean;
}

export interface VerifySlotDeps {
  pid?: number;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

function slotsDir(boardDir: string): string {
  return join(boardDir, 'verify-slots');
}

function exclusiveDir(boardDir: string): string {
  return join(slotsDir(boardDir), 'exclusive');
}

/** True while a live full-scope run holds the exclusive marker (a dead holder is reclaimed). */
export function exclusiveHeld(boardDir: string, alive: (pid: number) => boolean): boolean {
  const dir = exclusiveDir(boardDir);
  const holder = readPid(dir);
  if (holder !== null) return alive(holder);
  try {
    readdirSync(dir);
    return true; // marker exists, pid still being written
  } catch {
    return false;
  }
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPid(dir: string): number | null {
  try {
    const n = Number(readFileSync(join(dir, 'pid'), 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Held slots with their holder pid (null while the pid file is still being written). */
export function listVerifySlots(
  boardDir: string,
  isAlive: (pid: number) => boolean = defaultAlive,
): { index: number; pid: number | null; alive: boolean }[] {
  let names: string[];
  try {
    names = readdirSync(slotsDir(boardDir));
  } catch {
    return [];
  }
  const out: { index: number; pid: number | null; alive: boolean }[] = [];
  for (const name of names) {
    const m = /^slot-(\d+)$/.exec(name);
    if (!m) continue;
    const pid = readPid(join(slotsDir(boardDir), name));
    out.push({ index: Number(m[1]), pid, alive: pid === null ? true : isAlive(pid) });
  }
  return out.sort((a, b) => a.index - b.index);
}

function tryTake(boardDir: string, index: number, pid: number, alive: (p: number) => boolean) {
  const dir = join(slotsDir(boardDir), `slot-${index}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'pid'), String(pid));
      return dir;
    } catch {
      const holder = readPid(dir);
      if (holder === null || alive(holder)) return null;
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return null;
}

/** Wait for a free slot and take it. Throws only if the slot directory cannot be created. */
export async function acquireVerifySlot(
  boardDir: string,
  deps: VerifySlotDeps = {},
  options: VerifySlotOptions = {},
): Promise<VerifySlot> {
  const pid = deps.pid ?? process.pid;
  const alive = deps.isAlive ?? defaultAlive;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  mkdirSync(slotsDir(boardDir), { recursive: true });
  const poll = deps.pollMs ?? VERIFY_SLOT_POLL_MS;
  if (options.exclusive) return acquireExclusive(boardDir, pid, alive, sleep, poll);
  for (;;) {
    if (exclusiveHeld(boardDir, alive)) {
      await sleep(poll);
      continue;
    }
    for (let i = 0; i < VERIFY_SLOT_COUNT; i++) {
      const dir = tryTake(boardDir, i, pid, alive);
      if (dir) {
        const held = listVerifySlots(boardDir, alive).filter((s) => s.alive).length;
        return {
          index: i,
          workers: held > 1 ? VERIFY_WORKERS_SHARED : VERIFY_WORKERS_ALONE,
          release: () => rmSync(dir, { recursive: true, force: true }),
        };
      }
    }
    await sleep(poll);
  }
}

async function acquireExclusive(
  boardDir: string,
  pid: number,
  alive: (p: number) => boolean,
  sleep: (ms: number) => Promise<void>,
  poll: number,
): Promise<VerifySlot> {
  const dir = exclusiveDir(boardDir);
  // Phase 1: take the marker (atomic mkdir); from here new acquirers wait.
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'pid'), String(pid));
      break;
    } catch {
      const holder = readPid(dir);
      if (holder !== null && !alive(holder)) rmSync(dir, { recursive: true, force: true });
      else await sleep(poll);
    }
  }
  const release = () => rmSync(dir, { recursive: true, force: true });
  // Phase 2: wait for every verify that already holds a slot to finish.
  try {
    while (listVerifySlots(boardDir, alive).some((s) => s.alive && s.pid !== pid)) {
      await sleep(poll);
    }
  } catch (e) {
    release();
    throw e;
  }
  return { index: -1, workers: VERIFY_WORKERS_ALONE, release };
}
