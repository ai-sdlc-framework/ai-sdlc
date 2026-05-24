/**
 * fs-lock tests — RFC-0016 §10.1 (AISDLC-328).
 *
 * Covers acquisition, release, stale-lock recovery, and contention
 * timeout. The lock primitive is the substrate that the class-cache
 * critical section uses; correctness here is load-bearing for the
 * Phase-5 hardening AC.
 */

import { closeSync, existsSync, mkdtempSync, openSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireFileLock, withFileLock } from './fs-lock.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'fs-lock-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('acquireFileLock', () => {
  it('creates a sibling .lock file and removes it on release', () => {
    const target = join(workdir, 'target.json');
    const lockPath = `${target}.lock`;
    const release = acquireFileLock(target);
    expect(existsSync(lockPath)).toBe(true);
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('creates the parent directory if it does not exist', () => {
    const target = join(workdir, 'nested', 'deep', 'target.json');
    const release = acquireFileLock(target);
    expect(existsSync(`${target}.lock`)).toBe(true);
    release();
  });

  it('throws when the lock is already held by another caller', () => {
    const target = join(workdir, 'contended.json');
    const release = acquireFileLock(target);
    try {
      expect(() => acquireFileLock(target, { maxWaitMs: 100, retryIntervalMs: 10 })).toThrowError(
        /could not acquire lock/,
      );
    } finally {
      release();
    }
  });

  it('clears a stale lock and grants the lock to a new caller', () => {
    const target = join(workdir, 'stale.json');
    const lockPath = `${target}.lock`;

    // Manually create the lock file as if a previous process crashed.
    const fd = openSync(lockPath, 'wx');
    try {
      // Backdate the mtime to look stale.
      const oldMtime = new Date(Date.now() - 60_000); // 60s ago
      utimesSync(lockPath, oldMtime, oldMtime);
    } finally {
      // Close the fd so a fresh acquire isn't blocked by anything other
      // than the file's existence.
      closeSync(fd);
    }

    expect(existsSync(lockPath)).toBe(true);
    const release = acquireFileLock(target, {
      staleAfterMs: 1_000,
      maxWaitMs: 500,
      retryIntervalMs: 25,
    });
    release();
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('withFileLock', () => {
  it('runs the closure while holding the lock and releases on success', () => {
    const target = join(workdir, 'with.json');
    const lockPath = `${target}.lock`;
    const result = withFileLock(target, () => {
      expect(existsSync(lockPath)).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lock even when the closure throws', () => {
    const target = join(workdir, 'throws.json');
    const lockPath = `${target}.lock`;
    expect(() =>
      withFileLock(target, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });
});
