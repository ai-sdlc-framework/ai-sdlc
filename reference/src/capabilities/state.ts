import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getCapability, listCapabilities } from './registry.js';
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
  return { live: 0, shadow: 0, degraded: 0 };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Acquire an O_EXCL lockfile with bounded wait. Returns false if not acquired. */
function acquireLock(lockPath: string): boolean {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      return true;
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between attempts
      }
      if (Date.now() >= deadline) return false;
      sleepSync(2 + Math.floor(Math.random() * 8));
    }
  }
}

function readState(file: string): CapabilityStateFile {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as CapabilityStateFile;
    if (parsed && typeof parsed === 'object' && parsed.capabilities) return parsed;
  } catch {
    // missing or corrupt: start fresh
  }
  return { version: 1, capabilities: {} };
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
    const dir = stateDir(opts.artifactsDir);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'state.json');
    const lock = join(dir, 'state.lock');
    if (!acquireLock(lock)) return;
    try {
      const state = readState(file);
      const now = (opts.now?.() ?? new Date()).toISOString();
      const rec: CapabilityRecord = state.capabilities[id] ?? { counts: emptyCounts() };
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
        if (opts.reason !== undefined) rec.lastDegradedReason = opts.reason;
      }
      if (!getCapability(id)) rec.unregistered = true;
      state.capabilities[id] = rec;
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, file);
    } finally {
      rmSync(lock, { force: true });
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
    const rec = state.capabilities[id];
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
