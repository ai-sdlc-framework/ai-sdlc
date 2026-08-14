import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireTaskIdLock, taskIdLockFilePath } from './task-id-lock.js';

/**
 * Tests for AISDLC-559: parent-repo lock guarding the task-id
 * read-then-create window.
 */

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'aisdlc-559-lock-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('acquireTaskIdLock (AISDLC-559)', () => {
  it('creates the lock file under <parent>/.ai-sdlc/locks/ and release() removes it', async () => {
    const path = taskIdLockFilePath(scratch);
    const handle = await acquireTaskIdLock(scratch);
    expect(existsSync(path)).toBe(true);
    handle.release();
    expect(existsSync(path)).toBe(false);
  });

  it('release() is idempotent (safe to call twice)', async () => {
    const handle = await acquireTaskIdLock(scratch);
    handle.release();
    expect(() => handle.release()).not.toThrow();
  });

  it('steals a stale lock left by a crashed holder', async () => {
    // Simulate a crashed prior holder: lock file exists, mtime is older
    // than the stale threshold.
    const lockDir = join(scratch, '.ai-sdlc', 'locks');
    mkdirSync(lockDir, { recursive: true });
    const path = taskIdLockFilePath(scratch);
    writeFileSync(path, JSON.stringify({ pid: 999999 }), 'utf-8');
    const oldSec = Date.now() / 1000 - 60; // 60s ago
    utimesSync(path, oldSec, oldSec);

    const handle = await acquireTaskIdLock(scratch, { staleMs: 5_000, timeoutMs: 2_000 });
    expect(handle).toBeDefined();
    handle.release();
  });

  it('waits for a fresh lock to be released, then acquires it', async () => {
    const first = await acquireTaskIdLock(scratch, { pollMs: 10, timeoutMs: 3_000 });

    const secondPromise = acquireTaskIdLock(scratch, { pollMs: 10, timeoutMs: 3_000 });

    // Give the second call time to observe contention and start polling.
    await new Promise((resolve) => setTimeout(resolve, 60));
    first.release();

    const second = await secondPromise;
    expect(second).toBeDefined();
    second.release();
  });

  it('throws a clear contention error when a fresh lock does not clear within timeoutMs', async () => {
    const first = await acquireTaskIdLock(scratch);
    // Second call: lock is fresh (just acquired), stale threshold is long,
    // timeout is short — must give up and throw rather than hang forever.
    await expect(
      acquireTaskIdLock(scratch, { staleMs: 60_000, timeoutMs: 100, pollMs: 20 }),
    ).rejects.toThrow(/lock contention/i);
    first.release();
  });
});
