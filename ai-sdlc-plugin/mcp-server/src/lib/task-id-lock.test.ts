import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const __dirnameForTest = dirname(fileURLToPath(import.meta.url));
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

describe('task-id lock — ownership token (AISDLC-559 round-2 review)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aisdlc-559-token-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // This is the race the token exists to close, and it had ZERO coverage:
  // removing the token check entirely left all 208 tests green. Without it, a
  // holder whose critical section outran staleMs has its lock stolen by B, and
  // then its own release() deletes B's lock — two simultaneous holders.
  it('a superseded holder must NOT delete the lock of the holder that replaced it', async () => {
    const path = taskIdLockFilePath(root);

    const a = await acquireTaskIdLock(root, { staleMs: 20, timeoutMs: 500, pollMs: 5 });
    const tokenA = JSON.parse(readFileSync(path, 'utf-8')).token as string;

    // A's critical section outruns staleMs; B legitimately steals the lock.
    await new Promise((r) => setTimeout(r, 60));
    const b = await acquireTaskIdLock(root, { staleMs: 20, timeoutMs: 500, pollMs: 5 });
    const tokenB = JSON.parse(readFileSync(path, 'utf-8')).token as string;
    expect(tokenB).not.toEqual(tokenA);

    // A now finishes and releases. It must be a no-op, not a theft.
    a.release();

    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf-8')).token).toEqual(tokenB);

    b.release();
    expect(existsSync(path)).toBe(false);
  });

  // Round-2 review: `stolen = true` was set even when unlinkSync THREW, and
  // `if (stolen) continue` skips both the deadline check and the sleep — so a
  // stale lock that cannot be removed span forever at 100% CPU and hung the
  // MCP server. A directory at the lock path reproduces it exactly: openSync
  // 'wx' still reports EEXIST, while unlink cannot remove it.
  it('terminates instead of spinning when a stale lock cannot be unlinked', async () => {
    const path = taskIdLockFilePath(root);
    mkdirSync(path, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);

    const started = Date.now();
    await expect(
      acquireTaskIdLock(root, { staleMs: 10, timeoutMs: 300, pollMs: 10 }),
    ).rejects.toThrow(/lock contention/);
    const elapsed = Date.now() - started;
    // Bounded by timeoutMs rather than looping forever.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('release() is a safe no-op when the lock file is gone or corrupt', async () => {
    const path = taskIdLockFilePath(root);
    const h = await acquireTaskIdLock(root, { staleMs: 50, timeoutMs: 500, pollMs: 5 });
    writeFileSync(path, 'not json at all', 'utf-8');
    expect(() => h.release()).not.toThrow();
  });

  // The defaults must be self-healing within ONE call: with staleMs > timeoutMs
  // a crashed holder could never be reclaimed, because the deadline always
  // fired first.
  it('reclaims a crashed holder using the SHIPPED defaults, not hand-picked ones', async () => {
    const path = taskIdLockFilePath(root);
    mkdirSync(join(root, '.ai-sdlc', 'locks'), { recursive: true });
    // Simulate a crashed holder: a lock file old enough to be stale.
    writeFileSync(path, JSON.stringify({ token: 'dead', pid: 1 }), 'utf-8');
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);

    const h = await acquireTaskIdLock(root); // no overrides — shipped defaults
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf-8')).token).not.toEqual('dead');
    h.release();
  });
});

describe('task-id lock — REAL two-process contention (AISDLC-559)', () => {
  // Both round-2 reviewers independently found the existing contention tests
  // are single-process simulations: flipping openSync's 'wx' to 'w', which
  // disables mutual exclusion outright, was caught by only 1 of 5 and only as
  // a side effect. Two async calls in one process can interleave cooperatively
  // without ever racing at the OS level, so they cannot prove exclusion.
  //
  // This spawns genuinely separate node processes contending for the same lock
  // file and asserts their critical sections never overlap.
  let root: string;
  let pkgDir: string;

  beforeAll(() => {
    pkgDir = join(__dirnameForTest, '..', '..');
    // Compile so the children can import the REAL lock module. ~1s. Building
    // here (rather than trusting dist) keeps the test self-sufficient — a
    // stale dist would otherwise silently test yesterday's code.
    execFileSync('pnpm', ['exec', 'tsc'], { cwd: pkgDir, stdio: 'pipe' });
  }, 120_000);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aisdlc-559-2proc-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('never lets two processes hold the lock at the same time', async () => {
    const lockDist = join(pkgDir, 'dist', 'lib', 'task-id-lock.js');
    expect(existsSync(lockDist)).toBe(true);

    const logPath = join(root, 'critical-section.log');
    const workerPath = join(root, 'worker.mjs');
    writeFileSync(
      workerPath,
      `
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [lockDist, lockRoot, logPath, id] = process.argv.slice(2);
const { acquireTaskIdLock } = await import(pathToFileURL(lockDist).href);
const h = await acquireTaskIdLock(lockRoot, { staleMs: 5000, timeoutMs: 20000, pollMs: 5 });
appendFileSync(logPath, 'ENTER ' + id + '\\n');
// Hold long enough that an overlap would be unmissable, but well under staleMs
// so no legitimate steal occurs.
await new Promise((r) => setTimeout(r, 200));
appendFileSync(logPath, 'EXIT ' + id + '\\n');
h.release();
`,
      'utf-8',
    );

    const workers = ['A', 'B', 'C'].map(
      (id) =>
        new Promise<number>((resolve, reject) => {
          const child = spawn(process.execPath, [workerPath, lockDist, root, logPath, id], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stderr = '';
          child.stderr.on('data', (d) => (stderr += String(d)));
          child.on('exit', (code) =>
            code === 0 ? resolve(code) : reject(new Error(`worker ${id} failed: ${stderr}`)),
          );
        }),
    );
    await Promise.all(workers);

    const events = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(events).toHaveLength(6);

    // The load-bearing assertion: every ENTER must be closed by its OWN EXIT
    // before any other ENTER appears. Any interleaving means two processes
    // were inside the critical section simultaneously.
    let held: string | null = null;
    for (const line of events) {
      const [kind, id] = line.split(' ');
      if (kind === 'ENTER') {
        expect(held, `overlap: ${id} entered while ${held} still held the lock`).toBeNull();
        held = id;
      } else {
        expect(held).toBe(id);
        held = null;
      }
    }
    expect(held).toBeNull();
  }, 120_000);
});
