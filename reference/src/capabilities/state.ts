import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getCapability, listCapabilities } from './registry.js';
import { CAPABILITY_OUTCOMES } from './types.js';
import type {
  CapabilityOutcome,
  CapabilityRecord,
  CapabilityStateFile,
  CapabilityStateRow,
  CapabilityStatus,
} from './types.js';

const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 5000;

export interface ReportCapabilityOptions {
  /** Why the capability degraded (or any short reason). Never input text. */
  reason?: string;
  /** Root artifacts directory. Defaults to $ARTIFACTS_DIR or `.ai-sdlc/artifacts`. */
  artifactsDir?: string;
  /** Clock override for tests. */
  now?: () => Date;
}

function resolveDir(artifactsDir?: string): string {
  return artifactsDir ?? process.env.ARTIFACTS_DIR ?? join('.ai-sdlc', 'artifacts');
}

function stateDir(artifactsDir?: string): string {
  return join(resolveDir(artifactsDir), '_capabilities');
}

function emptyCounts(): Record<CapabilityOutcome, number> {
  return Object.fromEntries(CAPABILITY_OUTCOMES.map((o) => [o, 0])) as Record<
    CapabilityOutcome,
    number
  >;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
const MAX_REASON = 200;
const RESERVED_IDS = new Set(['constructor', 'prototype']);

function validId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id) && !RESERVED_IDS.has(id);
}

function token(): string {
  return `${process.pid}.${Math.random().toString(36).slice(2)}`;
}

/** Acquire an O_EXCL lockfile with bounded wait. Returns false if not acquired. */
function acquireLock(lockPath: string, tok: string): boolean {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(lockPath, tok, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
        }
      } catch {
        // lock vanished or cannot be inspected; fall through to the deadline check
      }
      if (Date.now() >= deadline) return false;
      sleepSync(2 + Math.floor(Math.random() * 8));
    }
  }
}

function releaseLock(lockPath: string, tok: string): void {
  try {
    if (readFileSync(lockPath, 'utf-8') === tok) rmSync(lockPath, { force: true });
  } catch {
    // already gone
  }
}

function sanitizeReason(reason: string): string {
  // eslint-disable-next-line no-control-regex
  return reason.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_REASON);
}

function readState(file: string): CapabilityStateFile {
  const caps: Record<string, CapabilityRecord> = Object.create(null);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as CapabilityStateFile;
    if (parsed && typeof parsed === 'object' && parsed.capabilities) {
      for (const [k, v] of Object.entries(parsed.capabilities)) {
        if (validId(k) && v && typeof v === 'object') caps[k] = v;
      }
    }
  } catch {
    // missing or corrupt: start fresh
  }
  return { version: 1, capabilities: caps };
}

/**
 * Record how a capability ran. Never throws and never alters caller behaviour.
 * The state file holds only ids, counts, timestamps and reason strings.
 */
export function reportCapabilityOutcome(
  id: string,
  outcome: CapabilityOutcome,
  opts: ReportCapabilityOptions = {},
): void {
  try {
    if (!validId(id)) return;
    const dir = stateDir(opts.artifactsDir);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'state.json');
    const lock = join(dir, 'state.lock');
    const tok = token();
    if (!acquireLock(lock, tok)) return;
    let tmp: string | undefined;
    try {
      const state = readState(file);
      const now = (opts.now?.() ?? new Date()).toISOString();
      const rec: CapabilityRecord = (Object.hasOwn(state.capabilities, id)
        ? state.capabilities[id]
        : undefined) ?? { counts: emptyCounts() };
      rec.counts = { ...emptyCounts(), ...rec.counts };
      rec.counts[outcome] += 1;
      rec.lastOutcome = outcome;
      if (outcome === 'live') {
        rec.firstLiveAt ??= now;
        rec.lastLiveAt = now;
      } else if (outcome === 'shadow') {
        rec.lastShadowAt = now;
      } else {
        rec.lastDegradedAt = now;
        if (opts.reason !== undefined) rec.lastDegradedReason = sanitizeReason(String(opts.reason));
      }
      if (!getCapability(id)) rec.unregistered = true;
      state.capabilities[id] = rec;
      tmp = `${file}.${token()}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
      renameSync(tmp, file);
      tmp = undefined;
    } finally {
      if (tmp) rmSync(tmp, { force: true });
      releaseLock(lock, tok);
    }
  } catch {
    // reporting must never affect the caller
  }
}

/** Current status: the outcome of the most recent report, else `never-observed`. */
export function deriveCapabilityStatus(rec: CapabilityRecord | undefined): CapabilityStatus {
  return rec?.lastOutcome ?? 'never-observed';
}

/** One row per registered capability, plus any unregistered ids in the file. */
export function readCapabilityState(artifactsDir?: string): CapabilityStateRow[] {
  const file = join(stateDir(artifactsDir), 'state.json');
  const state = existsSync(file) ? readState(file) : { version: 1 as const, capabilities: {} };
  const toRow = (id: string, title?: string): CapabilityStateRow => {
    const rec = Object.hasOwn(state.capabilities, id) ? state.capabilities[id] : undefined;
    return {
      id,
      title,
      status: deriveCapabilityStatus(rec),
      counts: { ...emptyCounts(), ...rec?.counts },
      firstLiveAt: rec?.firstLiveAt,
      lastLiveAt: rec?.lastLiveAt,
      lastShadowAt: rec?.lastShadowAt,
      lastDegradedAt: rec?.lastDegradedAt,
      lastDegradedReason: rec?.lastDegradedReason,
      unregistered: !title,
    };
  };
  const rows = listCapabilities().map((c) => toRow(c.id, c.title));
  const known = new Set(rows.map((r) => r.id));
  for (const id of Object.keys(state.capabilities)) {
    if (!known.has(id)) rows.push(toRow(id));
  }
  return rows;
}
