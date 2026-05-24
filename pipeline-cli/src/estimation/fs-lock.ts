/**
 * Cross-process advisory file lock — RFC-0016 §10.1 (AISDLC-328).
 *
 * Used by the class-assignment cache writer to serialise the read →
 * mutate → write critical section so two concurrent estimators for
 * different tasks cannot wipe each other's entries.
 *
 * Implementation mirrors `decisions/event-log.ts`'s lock helper
 * (AISDLC-395): `open(path, 'wx')` (O_CREAT | O_EXCL) on a sibling
 * `<file>.lock` path. First writer wins; concurrent attempts get
 * EEXIST and retry. Stale locks (older than `STALE_LOCK_MS`) are
 * forcibly cleared so a crashed estimator can't deadlock the cache.
 *
 * Single-machine only — per RFC-0016 §10.1 out-of-scope, cross-machine
 * coordination (e.g. NFS-safe locking) is a Phase 6+ surface. Dogfood
 * runs all estimators on one machine.
 *
 * @module estimation/fs-lock
 */

import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

const STALE_LOCK_MS = 30_000;
const LOCK_RETRY_INTERVAL_MS = 25;
const LOCK_MAX_WAIT_MS = 5_000;

export interface AcquireLockOpts {
  /**
   * Hold-time after which the lock is considered abandoned (default
   * 30s). A crashed estimator must not block subsequent writers
   * indefinitely.
   */
  staleAfterMs?: number;
  /** Sleep between retry attempts (default 25ms). */
  retryIntervalMs?: number;
  /** Max wait before giving up (default 5_000ms). */
  maxWaitMs?: number;
}

/**
 * Acquire an exclusive lock on `targetPath`. Returns a release
 * function. The lock is implemented as a sibling `<targetPath>.lock`
 * file created with O_EXCL semantics.
 *
 * Throws when the lock cannot be acquired within `maxWaitMs` — callers
 * SHOULD wrap calls in a `try/catch` and fall back to best-effort
 * lock-free behaviour rather than crashing the pipeline.
 */
export function acquireFileLock(targetPath: string, opts: AcquireLockOpts = {}): () => void {
  const staleAfter = opts.staleAfterMs ?? STALE_LOCK_MS;
  const retryInterval = opts.retryIntervalMs ?? LOCK_RETRY_INTERVAL_MS;
  const maxWait = opts.maxWaitMs ?? LOCK_MAX_WAIT_MS;
  const lockPath = `${targetPath}.lock`;
  const dir = dirname(lockPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + maxWait;
  let fd: number | null = null;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch (err) {
      lastErr = err;
      clearIfStale(lockPath, staleAfter);
      syncSleepMs(retryInterval);
    }
  }
  if (fd === null) {
    throw new Error(
      `[estimation/fs-lock] could not acquire lock at ${lockPath} within ${maxWait}ms` +
        (lastErr instanceof Error ? `: ${lastErr.message}` : ''),
    );
  }
  return function release(): void {
    try {
      closeSync(fd as number);
    } catch {
      /* ignore — best-effort close */
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore — lock file already gone */
    }
  };
}

/**
 * Run `fn` while holding the lock on `targetPath`. Use this for
 * read-modify-write critical sections where the caller MUST see a
 * stable file across the closure.
 */
export function withFileLock<T>(targetPath: string, fn: () => T, opts: AcquireLockOpts = {}): T {
  const release = acquireFileLock(targetPath, opts);
  try {
    return fn();
  } finally {
    release();
  }
}

function clearIfStale(lockPath: string, staleAfterMs: number): void {
  try {
    const st = statSync(lockPath);
    if (Date.now() - st.mtimeMs > staleAfterMs) unlinkSync(lockPath);
  } catch {
    // lock file disappeared between stat and unlink — fine.
  }
}

/**
 * Synchronous sleep that yields the thread (vs a CPU-pinning
 * busy-wait). Uses `Atomics.wait` on a private SharedArrayBuffer —
 * supported since Node 14.
 */
function syncSleepMs(ms: number): void {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}
