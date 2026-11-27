/**
 * Board-wide slots for machine verify runs (AISDLC-1087).
 *
 * At most `VERIFY_SLOT_COUNT` executors run a verify suite at once; the rest wait. A slot is a
 * directory `<boardDir>/verify-slots/slot-<n>/` created with atomic mkdir and holding a `pid`
 * file plus a `holder.json` record (AISDLC-1413): pid, process start time, command, task id,
 * when it was taken and the last heartbeat.
 *
 * A holder is identified by pid plus process start time, so liveness is one check: a dead pid,
 * or a pid now owned by a different process (start time mismatch, pid reuse), is reclaimed by
 * the next caller. A directory with no readable pid (its creator died between mkdir and the
 * pid write) counts as held for `PIDLESS_GRACE_MS`, then as dead (AISDLC-1383). A live holder
 * whose heartbeat is older than the stale threshold is reported as stale and never killed or
 * reclaimed; a wait that only such a holder blocks cannot succeed, so it is refused at once.
 *
 * No caller waits forever (AISDLC-1413): the wait is bounded by `maxWaitMs`, the holder is
 * logged when the wait starts and every `WAIT_LOG_INTERVAL_MS`, and a refusal names the holder.
 * While another slot is held, the run gets a lower vitest worker ceiling so the host is not
 * oversubscribed.
 *
 * @module runtime/verify-slots
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { formatDuration, startSpan, type SpanHandle } from '../telemetry/timings.js';

export const VERIFY_SLOT_COUNT = 2;
export const VERIFY_WORKERS_ALONE = 4;
export const VERIFY_WORKERS_SHARED = 2;
export const VERIFY_SLOT_POLL_MS = 500;
/** A slot or marker directory with no pid older than this is stale and reclaimed. */
export const PIDLESS_GRACE_MS = 30_000;
/** While waiting, the holder is logged when the wait starts and at least this often. */
export const WAIT_LOG_INTERVAL_MS = 30_000;
/** Default longest wait for a slot; `AI_SDLC_VERIFY_SLOT_MAX_WAIT_MS` overrides it. */
export const VERIFY_SLOT_MAX_WAIT_MS = 60 * 60_000;
/**
 * A live holder with no heartbeat for this long is stale. A verify run heartbeats before each
 * command and each command is bounded by the 20-minute verify timeout, so a progressing run
 * never crosses it.
 */
export const VERIFY_SLOT_STALE_MS = 25 * 60_000;

/**
 * - `held`: live holder with a recent heartbeat.
 * - `pending`: no pid written yet, inside the grace period.
 * - `stale`: live holder, no heartbeat past the stale threshold (blocks, never reclaimed).
 * - `reused`: the pid now belongs to another process (reclaimed by the next caller).
 * - `dead`: the pid is gone, or a pid-less directory past the grace period (reclaimed).
 */
export type HolderState = 'held' | 'pending' | 'stale' | 'reused' | 'dead';

export interface SlotHolder {
  /** `exclusive` or `slot-<n>`. */
  name: string;
  dir: string;
  pid: number | null;
  /** Process start time recorded when the slot was taken (null for a legacy holder). */
  startTime: string | null;
  command: string | null;
  taskId: string | null;
  takenAt: number;
  heartbeatAt: number;
  state: HolderState;
}

export interface VerifySlot {
  /** Slot index (-1 for the exclusive marker). */
  index: number;
  /** Worker ceiling for this run, from how many slots were held when it was acquired. */
  workers: number;
  release(): void;
  /** Record progress so the holder is not reported stale. Best effort. */
  heartbeat(): void;
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
  /** Start time of a running process, or null when it cannot be read. */
  startTimeOf?: (pid: number) => string | null;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** Clock for the grace period, heartbeats and the wait bound. */
  now?: () => number;
  /** Sink for the wait log (default: stderr). */
  log?: (line: string) => void;
  /** Longest wait before the caller is refused (default `VERIFY_SLOT_MAX_WAIT_MS`). */
  maxWaitMs?: number;
  /** Heartbeat age past which a live holder is stale (default `VERIFY_SLOT_STALE_MS`). */
  staleMs?: number;
  /** Command recorded for this holder (default: this process's argv). */
  command?: string;
  /** Task id recorded for this holder (default: from the environment). */
  taskId?: string;
  /**
   * Opens the `wait` span of this acquisition (AISDLC-1414); default appends to the timings
   * file. Its detail names what the wait is blocked on.
   */
  startWaitSpan?: () => Pick<SpanHandle, 'setDetail' | 'end'>;
}

/** Refusal of a slot wait: the limit elapsed, or only a stale holder blocks it. */
export class VerifySlotWaitError extends Error {
  override readonly name = 'VerifySlotWaitError';
  constructor(
    message: string,
    readonly holders: SlotHolder[],
  ) {
    super(message);
  }
}

interface Ctx {
  alive: (pid: number) => boolean;
  startTimeOf: (pid: number) => string | null;
  now: () => number;
  staleMs: number;
}

interface HolderRecord {
  pid: number;
  startTime: string | null;
  command: string | null;
  taskId: string | null;
  takenAt: number;
  heartbeatAt: number;
}

function slotsDir(boardDir: string): string {
  return join(boardDir, 'verify-slots');
}

function exclusiveDir(boardDir: string): string {
  return join(slotsDir(boardDir), 'exclusive');
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Process start time from `ps` in the C locale; null when unknown (no such pid, no `ps`). */
export function processStartTime(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    return out.trim().replace(/\s+/g, ' ') || null;
  } catch {
    return null;
  }
}

function defaultCommand(): string {
  const cmd = process.argv.slice(1).join(' ');
  return cmd.length > 200 ? `${cmd.slice(0, 197)}...` : cmd;
}

function defaultTaskId(): string | null {
  return process.env.AI_SDLC_ACTIVE_TASK_ID || process.env.AI_SDLC_EXECUTOR_TASK || null;
}

function context(deps: VerifySlotDeps): Ctx {
  return {
    alive: deps.isAlive ?? defaultAlive,
    startTimeOf: deps.startTimeOf ?? processStartTime,
    now: deps.now ?? Date.now,
    staleMs: deps.staleMs ?? VERIFY_SLOT_STALE_MS,
  };
}

function readPid(dir: string): number | null {
  try {
    const n = Number(readFileSync(join(dir, 'pid'), 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function readRecord(dir: string): Partial<HolderRecord> {
  try {
    const r = JSON.parse(readFileSync(join(dir, 'holder.json'), 'utf8')) as Partial<HolderRecord>;
    return r && typeof r === 'object' ? r : {};
  } catch {
    return {};
  }
}

function writeRecord(dir: string, record: HolderRecord): void {
  const tmp = join(dir, `holder.json.${record.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, join(dir, 'holder.json'));
}

/** The holder of a slot or marker directory, or null when the directory does not exist. */
function inspect(dir: string, name: string, ctx: Ctx): SlotHolder | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(dir).mtimeMs;
  } catch {
    return null;
  }
  const pid = readPid(dir);
  const rec = readRecord(dir);
  const takenAt = typeof rec.takenAt === 'number' ? rec.takenAt : mtimeMs;
  const holder: SlotHolder = {
    name,
    dir,
    pid,
    startTime: typeof rec.startTime === 'string' ? rec.startTime : null,
    command: typeof rec.command === 'string' ? rec.command : null,
    taskId: typeof rec.taskId === 'string' ? rec.taskId : null,
    takenAt,
    heartbeatAt: typeof rec.heartbeatAt === 'number' ? rec.heartbeatAt : takenAt,
    state: 'held',
  };
  if (pid === null) {
    holder.state = ctx.now() - mtimeMs < PIDLESS_GRACE_MS ? 'pending' : 'dead';
  } else if (!ctx.alive(pid)) {
    holder.state = 'dead';
  } else if (holder.startTime !== null && rec.pid === pid) {
    const current = ctx.startTimeOf(pid);
    if (current !== null && current !== holder.startTime) holder.state = 'reused';
  }
  if (holder.state === 'held' && ctx.now() - holder.heartbeatAt > ctx.staleMs) {
    holder.state = 'stale';
  }
  return holder;
}

/** True when the holder still keeps others out (dead and reused holders are reclaimed). */
function blocks(h: SlotHolder | null): h is SlotHolder {
  return h !== null && (h.state === 'held' || h.state === 'pending' || h.state === 'stale');
}

/** True while a live full-scope run holds the exclusive marker (a dead holder is reclaimed). */
export function exclusiveHeld(
  boardDir: string,
  alive: (pid: number) => boolean,
  now: () => number = Date.now,
  startTimeOf: (pid: number) => string | null = processStartTime,
): boolean {
  const ctx = { alive, now, startTimeOf, staleMs: VERIFY_SLOT_STALE_MS };
  return blocks(inspect(exclusiveDir(boardDir), 'exclusive', ctx));
}

function slotHolders(boardDir: string, ctx: Ctx): SlotHolder[] {
  let names: string[];
  try {
    names = readdirSync(slotsDir(boardDir));
  } catch {
    return [];
  }
  const out: SlotHolder[] = [];
  for (const name of names) {
    if (!/^slot-\d+$/.test(name)) continue;
    const h = inspect(join(slotsDir(boardDir), name), name, ctx);
    if (h) out.push(h); // null: released between readdir and stat
  }
  return out.sort((a, b) => slotIndex(a) - slotIndex(b));
}

function slotIndex(h: SlotHolder): number {
  return Number(h.name.slice('slot-'.length));
}

/**
 * Held slots with their holder pid (null while the pid file is still being written; such a
 * slot counts as alive only inside the grace period). A dead or reused pid is not alive.
 */
export function listVerifySlots(
  boardDir: string,
  isAlive: (pid: number) => boolean = defaultAlive,
  now: () => number = Date.now,
  startTimeOf: (pid: number) => string | null = processStartTime,
): { index: number; pid: number | null; alive: boolean }[] {
  const ctx = { alive: isAlive, now, startTimeOf, staleMs: VERIFY_SLOT_STALE_MS };
  return slotHolders(boardDir, ctx).map((h) => ({
    index: slotIndex(h),
    pid: h.pid,
    alive: blocks(h),
  }));
}

/** The exclusive marker (when present) and every slot directory, with its holder state. */
export function inspectVerifySlots(
  boardDir: string,
  deps: Pick<VerifySlotDeps, 'isAlive' | 'startTimeOf' | 'now' | 'staleMs'> = {},
): SlotHolder[] {
  const ctx = context(deps);
  const excl = inspect(exclusiveDir(boardDir), 'exclusive', ctx);
  return [...(excl ? [excl] : []), ...slotHolders(boardDir, ctx)];
}

export { formatDuration };

/** One-line identity of a holder: slot, pid, start time, command, task id, held-for, state. */
export function describeHolder(h: SlotHolder, now: number): string {
  const parts = [
    `${h.name} pid ${h.pid ?? 'not yet written'}`,
    `started ${h.startTime ?? 'unknown'}`,
    `command ${h.command ? JSON.stringify(h.command) : 'unknown'}`,
    ...(h.taskId ? [`task ${h.taskId}`] : []),
    `held for ${formatDuration(now - h.takenAt)}`,
  ];
  const flag =
    h.state === 'stale'
      ? ` STALE (alive, no heartbeat for ${formatDuration(now - h.heartbeatAt)}; not killed)`
      : h.state === 'reused'
        ? ' PID REUSED (pid now belongs to another process; reclaimed by the next caller)'
        : h.state === 'dead'
          ? ' DEAD (reclaimed by the next caller)'
          : '';
  return `${parts.join(', ')} at ${h.dir}${flag}`;
}

type Me = HolderRecord;

function take(dir: string, me: Me, ctx: Ctx): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'pid'), String(me.pid));
      writeRecord(dir, { ...me, takenAt: ctx.now(), heartbeatAt: ctx.now() });
      return true;
    } catch {
      if (blocks(inspect(dir, '', ctx))) return false;
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return false;
}

function handle(dir: string, me: Me, ctx: Ctx, index: number, workers: number): VerifySlot {
  return {
    index,
    workers,
    release: () => rmSync(dir, { recursive: true, force: true }),
    heartbeat: () => {
      try {
        const rec = readRecord(dir);
        if (rec.pid !== me.pid) return; // not ours any more
        writeRecord(dir, { ...(rec as HolderRecord), heartbeatAt: ctx.now() });
      } catch {
        // best effort: a missed beat only risks a stale report
      }
    },
  };
}

/** Bounded wait with a periodic log naming what blocks it. */
function waiter(ctx: Ctx, deps: VerifySlotDeps, span: Pick<SpanHandle, 'setDetail'>) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const poll = deps.pollMs ?? VERIFY_SLOT_POLL_MS;
  const log = deps.log ?? ((line: string) => console.error(line));
  const envMax = Number(process.env.AI_SDLC_VERIFY_SLOT_MAX_WAIT_MS);
  const maxWait =
    deps.maxWaitMs ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : VERIFY_SLOT_MAX_WAIT_MS);
  const started = ctx.now();
  let lastLog: number | null = null;
  /**
   * `stuckWhen`: `all` refuses once every blocker is stale (any free one ends the wait), `any`
   * once one is (the caller needs all of them gone).
   */
  return async (what: string, blockers: SlotHolder[], stuckWhen: 'all' | 'any') => {
    span.setDetail(what);
    const t = ctx.now();
    const who = blockers.map((h) => describeHolder(h, t)).join('; ') || 'none';
    const stale = blockers.filter((h) => h.state === 'stale');
    if (stale.length > 0 && (stuckWhen === 'any' || stale.length === blockers.length)) {
      throw new VerifySlotWaitError(
        `verify slot wait cannot succeed: ${what} is blocked by a stale holder (alive, no heartbeat for over ${formatDuration(ctx.staleMs)}; it is not killed): ${who}. Stop that process or remove its directory to free the slot`,
        blockers,
      );
    }
    const elapsed = t - started;
    if (elapsed >= maxWait) {
      throw new VerifySlotWaitError(
        `verify slot wait timed out after ${formatDuration(elapsed)} (limit ${formatDuration(maxWait)}) waiting for ${what}; held by: ${who}`,
        blockers,
      );
    }
    if (lastLog === null || t - lastLog >= WAIT_LOG_INTERVAL_MS) {
      lastLog = t;
      log(
        `[verify-slots] waiting ${formatDuration(elapsed)} (limit ${formatDuration(maxWait)}) for ${what}; held by: ${who}`,
      );
    }
    await sleep(poll);
  };
}

/**
 * Wait for a free slot and take it. Throws `VerifySlotWaitError` when the wait limit elapses or
 * only a stale holder blocks it, and a filesystem error when the slot directory cannot be made.
 */
export async function acquireVerifySlot(
  boardDir: string,
  deps: VerifySlotDeps = {},
  options: VerifySlotOptions = {},
): Promise<VerifySlot> {
  const ctx = context(deps);
  const pid = deps.pid ?? process.pid;
  const me: Me = {
    pid,
    startTime: ctx.startTimeOf(pid),
    command: deps.command ?? defaultCommand(),
    taskId: deps.taskId ?? defaultTaskId(),
    takenAt: 0,
    heartbeatAt: 0,
  };
  mkdirSync(slotsDir(boardDir), { recursive: true });
  // One `wait` span per acquisition, naming what it waited on (`none` when a slot was free).
  const span = deps.startWaitSpan
    ? deps.startWaitSpan()
    : startSpan('wait', 'verify-slot', {
        now: ctx.now,
        ...(options.exclusive ? { sub: 'exclusive' } : {}),
      });
  const wait = waiter(ctx, deps, span);
  try {
    const slot = options.exclusive
      ? await acquireExclusive(boardDir, me, ctx, wait)
      : await acquireShared(boardDir, me, ctx, wait, pid);
    span.end(0);
    return slot;
  } catch (e) {
    span.end(1);
    throw e;
  }
}

async function acquireShared(
  boardDir: string,
  me: Me,
  ctx: Ctx,
  wait: (what: string, blockers: SlotHolder[], stuckWhen: 'all' | 'any') => Promise<void>,
  pid: number,
): Promise<VerifySlot> {
  for (;;) {
    const excl = inspect(exclusiveDir(boardDir), 'exclusive', ctx);
    if (blocks(excl)) {
      await wait('the exclusive full-scope marker', [excl], 'any');
      continue;
    }
    for (let i = 0; i < VERIFY_SLOT_COUNT; i++) {
      const dir = join(slotsDir(boardDir), `slot-${i}`);
      if (take(dir, me, ctx)) {
        const held = slotHolders(boardDir, ctx).filter(blocks).length;
        return handle(dir, me, ctx, i, held > 1 ? VERIFY_WORKERS_SHARED : VERIFY_WORKERS_ALONE);
      }
    }
    const others = slotHolders(boardDir, ctx).filter((h) => blocks(h) && h.pid !== pid);
    await wait('a free slot', others, 'all');
  }
}

async function acquireExclusive(
  boardDir: string,
  me: Me,
  ctx: Ctx,
  wait: (what: string, blockers: SlotHolder[], stuckWhen: 'all' | 'any') => Promise<void>,
): Promise<VerifySlot> {
  const dir = exclusiveDir(boardDir);
  // Phase 1: take the marker (atomic mkdir); from here new acquirers wait.
  while (!take(dir, me, ctx)) {
    const holder = inspect(dir, 'exclusive', ctx);
    if (blocks(holder)) await wait('the exclusive full-scope marker', [holder], 'any');
  }
  const slot = handle(dir, me, ctx, -1, VERIFY_WORKERS_ALONE);
  // Phase 2: wait for every verify that already holds a slot to finish.
  try {
    for (;;) {
      const others = slotHolders(boardDir, ctx).filter((h) => blocks(h) && h.pid !== me.pid);
      if (others.length === 0) return slot;
      // The marker is held while waiting; beat so acquirers queued on it see a live holder.
      slot.heartbeat();
      await wait('running verifies to finish', others, 'any');
    }
  } catch (e) {
    slot.release();
    throw e;
  }
}
