/**
 * Board-wide slots for machine verify runs (AISDLC-1087).
 *
 * At most `VERIFY_SLOT_COUNT` executors run a verify suite at once; the rest wait. A slot is a
 * directory `<boardDir>/verify-slots/slot-<n>/` created with atomic mkdir and holding a `pid`
 * file. A slot whose pid is dead is reclaimed by the next caller; a live holder never is.
 * A directory with no readable pid (its creator died between mkdir and the pid write) counts
 * as held for `PIDLESS_GRACE_MS`, then as dead (AISDLC-1383). A wait longer than
 * `LONG_WAIT_NOTICE_MS` logs one line naming the holder pid and directory.
 * While another slot is held, the run gets a lower vitest worker ceiling so the host is not
 * oversubscribed.
 *
 * @module runtime/verify-slots
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const VERIFY_SLOT_COUNT = 2;
export const VERIFY_WORKERS_ALONE = 4;
export const VERIFY_WORKERS_SHARED = 2;
export const VERIFY_SLOT_POLL_MS = 500;
/** A slot or marker directory with no pid older than this is stale and reclaimed. */
export const PIDLESS_GRACE_MS = 30_000;
/** After this long waiting, one line names what the caller waits on. */
export const LONG_WAIT_NOTICE_MS = 60_000;

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
  /** Clock for the pid-less grace period and the long-wait notice. */
  now?: () => number;
  /** Sink for the long-wait notice (default: stderr). */
  log?: (line: string) => void;
}

function slotsDir(boardDir: string): string {
  return join(boardDir, 'verify-slots');
}

function exclusiveDir(boardDir: string): string {
  return join(slotsDir(boardDir), 'exclusive');
}

/**
 * Holder of a slot or marker directory: null when the directory does not exist, else its pid
 * and whether it still counts as held (live pid, or no pid yet but inside the grace period).
 */
function holderOf(
  dir: string,
  alive: (pid: number) => boolean,
  now: () => number,
): { pid: number | null; held: boolean } | null {
  const pid = readPid(dir);
  if (pid !== null) return { pid, held: alive(pid) };
  let mtimeMs: number;
  try {
    mtimeMs = statSync(dir).mtimeMs;
  } catch {
    return null;
  }
  return { pid: null, held: now() - mtimeMs < PIDLESS_GRACE_MS };
}

/** True while a live full-scope run holds the exclusive marker (a dead holder is reclaimed). */
export function exclusiveHeld(
  boardDir: string,
  alive: (pid: number) => boolean,
  now: () => number = Date.now,
): boolean {
  return holderOf(exclusiveDir(boardDir), alive, now)?.held ?? false;
}

/** Logs one line once the caller has waited `LONG_WAIT_NOTICE_MS`. */
function longWaitNotice(now: () => number, log: (line: string) => void) {
  const started = now();
  let logged = false;
  return (what: string) => {
    if (logged || now() - started < LONG_WAIT_NOTICE_MS) return;
    logged = true;
    log(`[verify-slots] waited ${LONG_WAIT_NOTICE_MS / 1000}s+ for ${what}`);
  };
}

function describeHolder(dir: string, pid: number | null): string {
  return `${dir} (pid ${pid ?? 'not yet written'})`;
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

/**
 * Held slots with their holder pid (null while the pid file is still being written; such a
 * slot counts as alive only inside the grace period).
 */
export function listVerifySlots(
  boardDir: string,
  isAlive: (pid: number) => boolean = defaultAlive,
  now: () => number = Date.now,
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
    const holder = holderOf(join(slotsDir(boardDir), name), isAlive, now);
    if (!holder) continue; // released between readdir and stat
    out.push({ index: Number(m[1]), pid: holder.pid, alive: holder.held });
  }
  return out.sort((a, b) => a.index - b.index);
}

function tryTake(
  boardDir: string,
  index: number,
  pid: number,
  alive: (p: number) => boolean,
  now: () => number,
) {
  const dir = join(slotsDir(boardDir), `slot-${index}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'pid'), String(pid));
      return dir;
    } catch {
      if (holderOf(dir, alive, now)?.held) return null;
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
  const now = deps.now ?? Date.now;
  const notice = longWaitNotice(now, deps.log ?? ((line) => console.error(line)));
  if (options.exclusive) return acquireExclusive(boardDir, pid, alive, sleep, poll, now, notice);
  for (;;) {
    const excl = holderOf(exclusiveDir(boardDir), alive, now);
    if (excl?.held) {
      notice(`the exclusive full-scope marker ${describeHolder(exclusiveDir(boardDir), excl.pid)}`);
      await sleep(poll);
      continue;
    }
    for (let i = 0; i < VERIFY_SLOT_COUNT; i++) {
      const dir = tryTake(boardDir, i, pid, alive, now);
      if (dir) {
        const held = listVerifySlots(boardDir, alive, now).filter((s) => s.alive).length;
        return {
          index: i,
          workers: held > 1 ? VERIFY_WORKERS_SHARED : VERIFY_WORKERS_ALONE,
          release: () => rmSync(dir, { recursive: true, force: true }),
        };
      }
    }
    notice(`a free slot; held: ${heldSlots(boardDir, alive, now, pid)}`);
    await sleep(poll);
  }
}

function heldSlots(
  boardDir: string,
  alive: (p: number) => boolean,
  now: () => number,
  self: number,
) {
  return listVerifySlots(boardDir, alive, now)
    .filter((s) => s.alive && s.pid !== self)
    .map((s) => describeHolder(join(slotsDir(boardDir), `slot-${s.index}`), s.pid))
    .join(', ');
}

async function acquireExclusive(
  boardDir: string,
  pid: number,
  alive: (p: number) => boolean,
  sleep: (ms: number) => Promise<void>,
  poll: number,
  now: () => number,
  notice: (what: string) => void,
): Promise<VerifySlot> {
  const dir = exclusiveDir(boardDir);
  // Phase 1: take the marker (atomic mkdir); from here new acquirers wait.
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'pid'), String(pid));
      break;
    } catch {
      const holder = holderOf(dir, alive, now);
      if (holder && !holder.held) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (holder) notice(`the exclusive full-scope marker ${describeHolder(dir, holder.pid)}`);
      await sleep(poll);
    }
  }
  const release = () => rmSync(dir, { recursive: true, force: true });
  // Phase 2: wait for every verify that already holds a slot to finish.
  try {
    while (listVerifySlots(boardDir, alive, now).some((s) => s.alive && s.pid !== pid)) {
      notice(`running verifies to finish: ${heldSlots(boardDir, alive, now, pid)}`);
      await sleep(poll);
    }
  } catch (e) {
    release();
    throw e;
  }
  return { index: -1, workers: VERIFY_WORKERS_ALONE, release };
}
