/**
 * Cross-process advisory lock built on atomic `mkdir`, plus an atomic
 * file-replace helper. Synchronous so callers stay simple and never interleave.
 *
 * The lock directory holds an owner token. A stale lock is reclaimed by
 * atomically renaming it aside, so only one reclaimer wins, and a holder only
 * removes the lock on release if the token is still its own. Long operations
 * call the `touch` function passed to the callback so a live holder is never
 * considered stale.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const LOCK_NAME = '.usage.lock';
const OWNER_FILE = 'owner';
const STALE_AFTER_MS = 30_000;
const WAIT_LIMIT_MS = 20_000;

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Invariant: every removal of the lock directory (reclaiming a stale lock, or
 * a holder releasing) happens while holding a short-lived claim file created
 * with O_EXCL. While a remover holds the claim, the lock path cannot become
 * absent, so nobody can mkdir a fresh lock there. The object a reclaimer
 * verified as stale is therefore exactly the object it removes, and a live
 * lock is never moved. The lock is never renamed back. The claim is held for
 * milliseconds; a claim older than CLAIM_STALE_MS belongs to a dead process.
 */
const CLAIM_STALE_MS = 10_000;

/** Test seams for `reclaimStale`; unused in production. */
export interface ReclaimHooks {
  /** Runs after the first staleness check, before the claim is taken. */
  afterStat?: () => void;
  /** Runs while the claim is held, after the lock was re-verified stale. */
  underClaim?: () => void;
}

function acquireClaim(claimPath: string, token: string): boolean {
  const started = Date.now();
  let delay = 1;
  for (;;) {
    try {
      writeFileSync(claimPath, token, { flag: 'wx', mode: FILE_MODE });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    }
    try {
      if (Date.now() - statSync(claimPath).mtimeMs > CLAIM_STALE_MS) {
        rmSync(claimPath, { force: true });
        continue;
      }
    } catch {
      continue; // claim vanished; retry immediately
    }
    if (Date.now() - started > WAIT_LIMIT_MS) return false;
    sleepSync(delay);
    delay = Math.min(delay * 2, 25);
  }
}

function releaseClaim(claimPath: string, token: string): void {
  try {
    if (readFileSync(claimPath, 'utf-8') === token) rmSync(claimPath, { force: true });
  } catch {
    // claim already gone
  }
}

/** Remove the lock directory atomically: rename aside, then delete the moved copy. */
function removeLockDir(lockPath: string): void {
  const aside = `${lockPath}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return;
  }
  rmSync(aside, { recursive: true, force: true });
}

function isStale(lockPath: string, staleAfterMs: number): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleAfterMs;
  } catch {
    return false; // absent: nothing to reclaim
  }
}

/**
 * Reclaim a stale lock. Staleness is re-verified under the claim immediately
 * before removal, so a lock that became live after the first check survives.
 * Exported for tests; not part of the package barrel.
 */
export function reclaimStale(
  lockPath: string,
  staleAfterMs: number,
  hooks: ReclaimHooks = {},
): boolean {
  if (!isStale(lockPath, staleAfterMs)) return false;
  hooks.afterStat?.();
  const claimPath = `${lockPath}.claim`;
  const token = `${process.pid}-${randomBytes(6).toString('hex')}`;
  if (!acquireClaim(claimPath, token)) return false;
  try {
    if (!isStale(lockPath, staleAfterMs)) return false;
    hooks.underClaim?.();
    removeLockDir(lockPath);
    return true;
  } finally {
    releaseClaim(claimPath, token);
  }
}

function ownerOf(lockPath: string): string | undefined {
  try {
    return readFileSync(join(lockPath, OWNER_FILE), 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Runs `fn` while holding the directory's lock. Creates the directory if
 * needed. `fn` receives a `touch` function that refreshes the lock's age.
 */
export function withUsageLock<T>(
  dir: string,
  fn: (touch: () => void) => T,
  staleAfterMs = STALE_AFTER_MS,
): T {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const lockPath = join(dir, LOCK_NAME);
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const started = Date.now();
  let delay = 1;
  for (;;) {
    try {
      mkdirSync(lockPath, { mode: DIR_MODE });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      reclaimStale(lockPath, staleAfterMs);
      if (Date.now() - started > WAIT_LIMIT_MS) {
        throw new Error('timed out waiting for the usage ledger lock', { cause: err });
      }
      sleepSync(delay);
      delay = Math.min(delay * 2, 25);
    }
  }
  try {
    writeFileSync(join(lockPath, OWNER_FILE), token, { mode: FILE_MODE });
  } catch {
    // the owner file is best effort; release then leaves an unowned lock to age out
  }
  const touch = (): void => {
    if (ownerOf(lockPath) !== token) return; // never refresh another holder's lock
    try {
      const now = new Date();
      utimesSync(lockPath, now, now);
    } catch {
      // lock was reclaimed; nothing to refresh
    }
  };
  try {
    return fn(touch);
  } finally {
    // Release under the claim so the owner check and removal cannot interleave
    // with a reclaimer or a new holder; remove only a lock that is still ours.
    const claimPath = `${lockPath}.claim`;
    const claimToken = `${process.pid}-${randomBytes(6).toString('hex')}`;
    if (acquireClaim(claimPath, claimToken)) {
      try {
        if (ownerOf(lockPath) === token) removeLockDir(lockPath);
      } finally {
        releaseClaim(claimPath, claimToken);
      }
    }
  }
}

/** Write `content` to `path` via a temp file and rename so readers never see a partial file. */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { encoding: 'utf-8', mode: FILE_MODE });
  renameSync(tmp, path);
}
