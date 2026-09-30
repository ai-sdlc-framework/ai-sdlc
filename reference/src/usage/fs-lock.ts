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
 * Try to reclaim a stale lock by renaming it aside. Returns normally whether or
 * not this caller won; the caller simply retries acquisition.
 */
function reclaimStale(lockPath: string, staleAfterMs: number): void {
  let seen;
  try {
    seen = statSync(lockPath);
  } catch {
    return; // already gone
  }
  if (Date.now() - seen.mtimeMs <= staleAfterMs) return;
  const aside = `${lockPath}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return; // another reclaimer won, or the holder released
  }
  try {
    // The path may have been re-acquired between our stat and our rename. If
    // what we moved aside is not the lock we judged stale, put it back.
    if (statSync(aside).ino !== seen.ino) {
      try {
        renameSync(aside, lockPath);
        return;
      } catch {
        // someone already holds a new lock; fall through and discard
      }
    }
  } catch {
    return;
  }
  rmSync(aside, { recursive: true, force: true });
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
    let owner: string | undefined;
    try {
      owner = readFileSync(join(lockPath, OWNER_FILE), 'utf-8');
    } catch {
      owner = undefined;
    }
    if (owner === token) rmSync(lockPath, { recursive: true, force: true });
  }
}

/** Write `content` to `path` via a temp file and rename so readers never see a partial file. */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { encoding: 'utf-8', mode: FILE_MODE });
  renameSync(tmp, path);
}
