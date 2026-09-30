/**
 * Cross-process advisory lock built on atomic `mkdir`, plus an atomic
 * file-replace helper. Synchronous so callers stay simple and never interleave.
 */

import { mkdirSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_NAME = '.usage.lock';
const STALE_AFTER_MS = 30_000;
const WAIT_LIMIT_MS = 20_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs `fn` while holding the directory's lock. Creates the directory if needed. */
export function withUsageLock<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, LOCK_NAME);
  const started = Date.now();
  let delay = 1;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_AFTER_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between the two calls; retry immediately
      }
      if (Date.now() - started > WAIT_LIMIT_MS) {
        throw new Error('timed out waiting for the usage ledger lock', { cause: err });
      }
      sleepSync(delay);
      delay = Math.min(delay * 2, 25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/** Write `content` to `path` via a temp file and rename so readers never see a partial file. */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}
