import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeFixtureDir } from './remove-fixture-dir.js';
import { rmSync } from 'node:fs';

// Never derive an "outside" path from process.cwd(): the checkout may live under tmpdir().
const OUTSIDE = dirname(realpathSync(tmpdir()));

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('removeFixtureDir', () => {
  it('removes a directory inside tmpdir', () => {
    const d = mkdtempSync(join(tmpdir(), 'rfd-'));
    writeFileSync(join(d, 'f'), 'x');
    removeFixtureDir(d);
    expect(existsSync(d)).toBe(false);
  });

  it('refuses a path outside tmpdir and deletes nothing', () => {
    const outside = OUTSIDE;
    expect(() => removeFixtureDir(outside)).toThrow(/refusing/);
    expect(existsSync(outside)).toBe(true);
  });

  it('refuses tmpdir itself and its parent', () => {
    expect(() => removeFixtureDir(tmpdir())).toThrow(/refusing/);
    expect(() => removeFixtureDir(dirname(realpathSync(tmpdir())))).toThrow(/refusing/);
  });

  it('refuses a dot-dot escape', () => {
    const d = mkdtempSync(join(tmpdir(), 'rfd-'));
    cleanup.push(d);
    expect(() => removeFixtureDir(join(d, '..', '..'))).toThrow(/refusing/);
  });

  it('refuses a symlink in tmpdir that points outside tmpdir', () => {
    const d = mkdtempSync(join(tmpdir(), 'rfd-'));
    cleanup.push(d);
    const link = join(d, 'link');
    symlinkSync(OUTSIDE, link);
    expect(() => removeFixtureDir(link)).toThrow(/refusing/);
    expect(existsSync(OUTSIDE)).toBe(true);
  });

  it('removes through a symlink that resolves inside tmpdir', () => {
    const d = mkdtempSync(join(tmpdir(), 'rfd-'));
    cleanup.push(d);
    const real = join(d, 'real');
    mkdirSync(real);
    const link = join(d, 'link');
    symlinkSync(real, link);
    removeFixtureDir(link);
    expect(existsSync(real)).toBe(false);
  });

  it('is a no-op for a nonexistent path inside tmpdir', () => {
    expect(() => removeFixtureDir(join(tmpdir(), 'rfd-does-not-exist', 'x'))).not.toThrow();
  });

  it('refuses a nonexistent path outside tmpdir', () => {
    expect(() => removeFixtureDir(join(OUTSIDE, 'rfd-does-not-exist'))).toThrow(/refusing/);
  });

  it('refuses an empty path', () => {
    expect(() => removeFixtureDir('')).toThrow(/empty/);
  });
});
