/**
 * Single-instance lock and launch spacing for the usage ingester (AISDLC-1191).
 *
 * The lock is a file created exclusively (`wx`) holding the owner pid. A lock
 * whose pid is dead, or whose file is older than `maxAgeMs`, is taken over.
 * The launch stamp is the same file the Stop hook writes (`.ingest-launch`),
 * so a tick and the hook space their launches against each other.
 */

import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_FILE = '.ingest.lock';
export const STAMP_FILE = '.ingest-launch';
export const DEFAULT_INTERVAL_MS = 20_000;
/** A lock older than this is stale even when its pid is alive (pid reuse, hung run). */
export const LOCK_MAX_AGE_MS = 5 * 60_000;
export const INTERVAL_ENV = 'AI_SDLC_USAGE_INGEST_INTERVAL_MS';

/** Minimum spacing between launches; the env value wins when it is a non-negative number. */
export function ingestIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[INTERVAL_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INTERVAL_MS;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockIsStale(path: string, now: number, maxAgeMs: number): boolean {
  try {
    if (now - statSync(path).mtimeMs > maxAgeMs) return true;
    const pid = Number.parseInt(readFileSync(path, 'utf-8').trim(), 10);
    return !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid);
  } catch {
    return true;
  }
}

/** Take the lock. Returns a release function, or undefined when a live run holds it. */
export function acquireIngestLock(
  dir: string,
  opts: { now?: () => number; maxAgeMs?: number; pid?: number } = {},
): (() => void) | undefined {
  const now = opts.now ?? Date.now;
  const maxAgeMs = opts.maxAgeMs ?? LOCK_MAX_AGE_MS;
  const path = join(dir, LOCK_FILE);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return () => {}; // cannot lock: run unguarded and let the store report its own errors
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(opts.pid ?? process.pid), { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
      if (!lockIsStale(path, now(), maxAgeMs)) return undefined;
      try {
        unlinkSync(path);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * True when a launch happened within the interval; otherwise records this one.
 * Cannot-stamp failures let the launch proceed (the lock still guards it).
 */
export function launchDebounced(dir: string, now: number, intervalMs: number): boolean {
  const stamp = join(dir, STAMP_FILE);
  try {
    if (now - statSync(stamp).mtimeMs < intervalMs) return true;
  } catch {
    // no stamp yet
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(stamp, '', { mode: 0o600 });
  } catch {
    // cannot debounce
  }
  return false;
}
