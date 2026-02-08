import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG_ROOT = resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(PKG_ROOT, 'package.json'), 'utf-8'));

describe('package.json exports', () => {
  it('has a root "." export with types and import', () => {
    expect(pkg.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
    });
  });

  it('has a "./runner" subpath export with types and import', () => {
    expect(pkg.exports['./runner']).toEqual({
      types: './dist/runner/index.d.ts',
      import: './dist/runner/index.js',
    });
  });

  it('dist files referenced by "./runner" export exist', () => {
    const runnerExport = pkg.exports['./runner'];
    expect(existsSync(resolve(PKG_ROOT, runnerExport.types))).toBe(true);
    expect(existsSync(resolve(PKG_ROOT, runnerExport.import))).toBe(true);
  });

  it('runner subpath re-exports expected symbols', async () => {
    const runner = await import(resolve(PKG_ROOT, pkg.exports['./runner'].import));
    expect(runner.GitHubActionsRunner).toBeDefined();
  });
});
