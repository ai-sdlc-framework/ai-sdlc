import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('@ai-sdlc/dogfood package.json exports', () => {
  const pkg = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf-8'),
  );

  it('has a "." root export with types and import', () => {
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

  it('runner subpath source file exports expected symbols', async () => {
    const runner = await import('./index.js');
    expect(runner.GitHubActionsRunner).toBeDefined();
  });
});
