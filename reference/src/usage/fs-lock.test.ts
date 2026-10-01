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
import { reclaimStale, withUsageLock, writeFileAtomic } from './fs-lock.js';

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

describe('reclaimStale', () => {
  const makeLock = (owner: string, ageMs: number) => {
    const lock = join(dir, '.usage.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), owner);
    const t = new Date(Date.now() - ageMs);
    utimesSync(lock, t, t);
    return lock;
  };

  it('removes a stale lock', () => {
    const lock = makeLock('old', 120_000);
    expect(reclaimStale(lock, 30_000)).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.claim`)).toBe(false);
  });

  it('leaves a live lock alone', () => {
    const lock = makeLock('live', 0);
    expect(reclaimStale(lock, 30_000)).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });

  it('never moves a live lock that replaced the stale one after the first check', () => {
    const lock = makeLock('old', 120_000);
    let removed = 0;
    const result = reclaimStale(lock, 30_000, {
      afterStat: () => {
        // another reclaimer removes the stale lock and a new holder takes a fresh one
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
        writeFileSync(join(lock, 'owner'), 'live-holder');
      },
      underClaim: () => {
        removed++;
      },
    });
    expect(result).toBe(false);
    expect(removed).toBe(0);
    expect(readFileSync(join(lock, 'owner'), 'utf-8')).toBe('live-holder');
    expect(existsSync(`${lock}.claim`)).toBe(false);
  });

  it('serialises the release of a holder behind an active claim', () => {
    // a holder that finishes while a reclaimer owns the claim must not remove
    // the lock until the claim is gone; here the claim is stale, so release proceeds
    const lock = join(dir, '.usage.lock');
    writeFileSync(`${lock}.claim`, 'dead-process');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${lock}.claim`, old, old);
    withUsageLock(dir, () => undefined);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.claim`)).toBe(false);
  });

  it('touch never refreshes a lock now owned by someone else', () => {
    const lock = join(dir, '.usage.lock');
    withUsageLock(dir, (touch) => {
      writeFileSync(join(lock, 'owner'), 'someone-else');
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      touch();
      expect(Date.now() - statSync(lock).mtimeMs).toBeGreaterThan(50_000);
    });
    expect(readFileSync(join(lock, 'owner'), 'utf-8')).toBe('someone-else');
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
            const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
            child.on('error', () => {
              clearTimeout(timer);
              done(null);
            });
            child.on('exit', (code) => {
              clearTimeout(timer);
              done(code);
            });
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
