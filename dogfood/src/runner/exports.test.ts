import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG_ROOT = resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(PKG_ROOT, 'package.json'), 'utf-8'));

describe('package.json exports', () => {
  it('defines a "." export with types and import', () => {
    expect(pkg.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
    });
  });

  it('defines a "./runner" subpath export with types and import', () => {
    expect(pkg.exports['./runner']).toEqual({
      types: './dist/runner/index.d.ts',
      import: './dist/runner/index.js',
    });
  });

  it('"./runner" export points to files that exist in dist', () => {
    const runnerExport = pkg.exports['./runner'];
    expect(existsSync(resolve(PKG_ROOT, runnerExport.types))).toBe(true);
    expect(existsSync(resolve(PKG_ROOT, runnerExport.import))).toBe(true);
  });

  it('"." export points to files that exist in dist', () => {
    const rootExport = pkg.exports['.'];
    expect(existsSync(resolve(PKG_ROOT, rootExport.types))).toBe(true);
    expect(existsSync(resolve(PKG_ROOT, rootExport.import))).toBe(true);
  });
});
