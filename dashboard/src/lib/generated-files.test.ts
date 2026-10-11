import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// AISDLC-813: `next build` rewrites these two files. They are committed in the
// exact form Next.js generates and excluded from Prettier, so a build leaves
// the tree clean and `format:check` passes.
const dashboardDir = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(dashboardDir, '..');

describe('Next.js generated files (AISDLC-813)', () => {
  it('lists both generated files in .prettierignore', () => {
    const ignored = readFileSync(path.join(repoRoot, '.prettierignore'), 'utf8').split('\n');
    expect(ignored).toContain('dashboard/next-env.d.ts');
    expect(ignored).toContain('dashboard/tsconfig.json');
  });

  it('commits next-env.d.ts in the form Next.js generates', () => {
    const src = readFileSync(path.join(dashboardDir, 'next-env.d.ts'), 'utf8');
    expect(src).toContain('import "./.next/types/routes.d.ts";');
    expect(src).not.toContain('/// <reference path=');
  });

  it('commits tsconfig.json in the form Next.js generates', () => {
    const src = readFileSync(path.join(dashboardDir, 'tsconfig.json'), 'utf8');
    expect(src).toContain('"jsx": "react-jsx"');
    expect(src).toContain('.next/dev/types/**/*.ts');
    expect(src).toContain('"lib": [\n      "dom"');
  });
});
