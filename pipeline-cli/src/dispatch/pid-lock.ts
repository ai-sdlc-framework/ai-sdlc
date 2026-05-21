/**
 * PID-file lock primitives for the Worker Supervisor (RFC-0041 §5.1).
 *
 * The supervisor is a singleton per project — exactly zero or one instance
 * should be alive at any time. We enforce that with a PID file at
 * `.ai-sdlc/dispatch/.supervisor.pid`:
 *
 *   - On start: refuse to acquire if the file's PID is still alive.
 *     Reclaim a stale file (PID present but dead).
 *   - On stop: remove the file, but ONLY if it points to the current
 *     process (defensive — another supervisor's PID is not ours to clear).
 *
 * Liveness is probed via `process.kill(pid, 0)` which throws ESRCH when
 * the PID has been reaped. This is the POSIX-portable way to test PID
 * existence without sending an actual signal.
 *
 * The helpers are kept in their own module so the core supervisor
 * spawn-loop stays at ≤200 LOC (AC #1) and the lock primitives can be
 * unit-tested in isolation.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** Result of attempting to acquire the supervisor PID lock. */
export interface PidLockResult {
  acquired: boolean;
  pid?: number;
  liveOwner?: number;
  reason?: string;
}

/**
 * Try to write a PID file. Refuses to overwrite a file whose owning PID is
 * still alive (signal 0 probe). Stale files (PID dead) are reclaimed.
 *
 * Returns `{ acquired: true, pid: process.pid }` on success.
 */
export function acquirePidLock(pidFile: string): PidLockResult {
  mkdirSync(path.dirname(pidFile), { recursive: true });
  if (existsSync(pidFile)) {
    const raw = readFileSync(pidFile, 'utf-8').trim();
    const existing = Number.parseInt(raw, 10);
    if (Number.isFinite(existing) && existing > 0 && isProcessAlive(existing)) {
      return {
        acquired: false,
        liveOwner: existing,
        reason: `supervisor pid=${existing} already running (lock=${pidFile})`,
      };
    }
    // Stale lock — reclaim.
  }
  writeFileSync(pidFile, `${process.pid}\n`, 'utf-8');
  return { acquired: true, pid: process.pid };
}

/** Read a PID from a lock file. Returns undefined if missing/corrupt. */
export function readPidFile(pidFile: string): number | undefined {
  if (!existsSync(pidFile)) return undefined;
  try {
    const n = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Remove the PID file if it points to the current process. Best-effort. */
export function releasePidLock(pidFile: string): void {
  const pid = readPidFile(pidFile);
  if (pid !== process.pid) return;
  try {
    rmSync(pidFile);
  } catch {
    /* ignore */
  }
}

/**
 * Liveness probe — `process.kill(pid, 0)` throws ESRCH when the PID has
 * been reaped. Returns false on any error.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
