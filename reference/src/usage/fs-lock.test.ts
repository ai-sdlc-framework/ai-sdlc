import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withUsageLock, writeFileAtomic } from './fs-lock.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-lock-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('withUsageLock', () => {
  it('releases the lock after the callback, even when it throws', () => {
    expect(withUsageLock(dir, () => 42)).toBe(42);
    expect(() =>
      withUsageLock(dir, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(join(dir, '.usage.lock'))).toBe(false);
  });

  it('reclaims a stale lock left by a dead process', () => {
    const lock = join(dir, '.usage.lock');
    mkdirSync(lock);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(withUsageLock(dir, () => 'ok')).toBe('ok');
  });
});

describe('withUsageLock safety', () => {
  it('does not delete a newer holder lock when its own lock was reclaimed', () => {
    const lock = join(dir, '.usage.lock');
    withUsageLock(dir, () => {
      // another process reclaims the stale lock and becomes the new holder
      renameSync(lock, `${lock}.stale-test`);
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner'), 'someone-else');
    });
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(join(lock, 'owner'), 'utf-8')).toBe('someone-else');
  });

  it('refreshes the lock age through touch', () => {
    const lock = join(dir, '.usage.lock');
    withUsageLock(dir, (touch) => {
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      touch();
      expect(Date.now() - statSync(lock).mtimeMs).toBeLessThan(5_000);
    });
  });

  it('lets only one of several contenders run at a time when racing on a stale lock', async () => {
    const lockPath = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fs-lock.ts');
    const counter = join(dir, 'counter');
    writeFileSync(counter, '0');
    const stale = join(dir, '.usage.lock');
    mkdirSync(stale);
    const old = new Date(Date.now() - 120_000);
    utimesSync(stale, old, old);
    const code = `
      import { readFileSync, writeFileSync } from 'node:fs';
      const { withUsageLock } = await import(${JSON.stringify(lockPath)});
      let overlap = false;
      for (let i = 0; i < 5; i++) {
        withUsageLock(process.env.LOCK_DIR, () => {
          if (readFileSync(process.env.COUNTER, 'utf-8') !== '0') overlap = true;
          writeFileSync(process.env.COUNTER, '1');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
          writeFileSync(process.env.COUNTER, '0');
        });
      }
      process.exit(overlap ? 3 : 0);
    `;
    const codes = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<number | null>((done) => {
            const child = spawn(
              process.execPath,
              ['--import', 'tsx', '--input-type=module', '-e', code],
              {
                env: { ...process.env, LOCK_DIR: dir, COUNTER: counter },
                cwd: resolve(fileURLToPath(new URL('.', import.meta.url)), '../..'),
                stdio: 'ignore',
              },
            );
            child.on('exit', done);
          }),
      ),
    );
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
  }, 120_000);
});

describe('writeFileAtomic', () => {
  it('replaces the file content', () => {
    const f = join(dir, 'x.json');
    writeFileAtomic(f, 'one');
    writeFileAtomic(f, 'two');
    expect(readFileSync(f, 'utf-8')).toBe('two');
  });
});
