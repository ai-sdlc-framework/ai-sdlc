import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('writeFileAtomic', () => {
  it('replaces the file content', () => {
    const f = join(dir, 'x.json');
    writeFileAtomic(f, 'one');
    writeFileAtomic(f, 'two');
    expect(readFileSync(f, 'utf-8')).toBe('two');
  });
});
