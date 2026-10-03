/**
 * AISDLC-687: hermetic tests for the pre-commit workspace typecheck runner.
 *
 * Each case builds a throwaway pnpm workspace in a temp dir (no network, no real packages) and
 * runs `scripts/typecheck-workspace.mjs --root <fixture>`. "Fresh worktree" = the upstream
 * package's declared build output (dist/index.d.ts) is absent.
 *
 * Run with: node --test scripts/typecheck-workspace.test.mjs
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SCRIPT = join(HERE, 'typecheck-workspace.mjs');

// The fixture packages have no node_modules, so borrow a real tsc from an installed package.
let TSC;
try {
  TSC = createRequire(join(REPO, 'orchestrator', 'package.json')).resolve('typescript/bin/tsc');
} catch {
  TSC = undefined;
}
const hasTsc = Boolean(TSC);

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    noEmit: true,
    strict: true,
    target: 'es2022',
    module: 'esnext',
    moduleResolution: 'bundler',
  },
  include: ['src'],
});

let root;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** pkgs: [{ dir, name, deps?: string[], built?: boolean, src: string }] */
function workspace(pkgs) {
  root = mkdtempSync(join(tmpdir(), 'ai-sdlc-typecheck-ws-'));
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    `packages:\n${pkgs.map((p) => `  - ${p.dir}`).join('\n')}\n`,
  );
  for (const p of pkgs) {
    const dir = join(root, p.dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: p.name,
        types: 'dist/index.d.ts',
        main: 'dist/index.js',
        dependencies: Object.fromEntries((p.deps ?? []).map((d) => [d, 'workspace:*'])),
      }),
    );
    writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG);
    writeFileSync(join(dir, 'src', 'index.ts'), p.src);
    if (p.built) {
      mkdirSync(join(dir, 'dist'));
      writeFileSync(join(dir, 'dist', 'index.d.ts'), 'export declare const v: number;\n');
    }
  }
  return root;
}

const run = (args = []) =>
  spawnSync(process.execPath, [SCRIPT, '--root', root, ...(TSC ? ['--tsc', TSC] : []), ...args], {
    encoding: 'utf-8',
    timeout: 120000,
  });

const OK = 'export const ok: number = 1;\n';
// Would fail type-checking if it ran: the sibling's types cannot be resolved.
const NEEDS_SIBLING = "import { v } from '@f/lib';\nexport const q: number = v;\n";
const TYPE_ERROR = "export const bad: number = 'not a number';\n";

describe('plan (--dry-run)', () => {
  it('skips a package whose upstream build output is missing and keeps the rest', () => {
    workspace([
      { dir: 'lib', name: '@f/lib', src: OK },
      { dir: 'app', name: '@f/app', deps: ['@f/lib'], src: NEEDS_SIBLING },
      { dir: 'solo', name: '@f/solo', src: OK },
    ]);
    const r = run(['--dry-run']);
    assert.equal(r.status, 0);
    const plan = JSON.parse(r.stdout);
    assert.deepEqual(plan.skipped, ['@f/app']);
    assert.deepEqual(plan.run.sort(), ['@f/lib', '@f/solo']);
  });

  it('keeps the dependent when the upstream build output is present', () => {
    workspace([
      { dir: 'lib', name: '@f/lib', built: true, src: OK },
      { dir: 'app', name: '@f/app', deps: ['@f/lib'], src: OK },
    ]);
    const plan = JSON.parse(run(['--dry-run']).stdout);
    assert.deepEqual(plan.skipped, []);
    assert.deepEqual(plan.run.sort(), ['@f/app', '@f/lib']);
  });

  it('skips transitively: app -> mid (built) -> lib (not built)', () => {
    workspace([
      { dir: 'lib', name: '@f/lib', src: OK },
      { dir: 'mid', name: '@f/mid', deps: ['@f/lib'], built: true, src: OK },
      { dir: 'app', name: '@f/app', deps: ['@f/mid'], src: OK },
    ]);
    const plan = JSON.parse(run(['--dry-run']).stdout);
    assert.deepEqual(plan.skipped.sort(), ['@f/app', '@f/mid']);
  });

  it('names the skipped package and the missing build output in one loud line', () => {
    workspace([
      { dir: 'lib', name: '@f/lib', src: OK },
      { dir: 'app', name: '@f/app', deps: ['@f/lib'], src: NEEDS_SIBLING },
    ]);
    const r = run(['--dry-run']);
    const lines = r.stderr.split('\n').filter((l) => l.includes('SKIPPED'));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[typecheck\] SKIPPED @f\/app/);
    assert.match(lines[0], /@f\/lib/);
    assert.match(lines[0], /dist[\\/]index\.d\.ts/);
  });

  it('ignores a workspace dependency that is not a workspace: range', () => {
    workspace([{ dir: 'app', name: '@f/app', src: OK }]);
    const plan = JSON.parse(run(['--dry-run']).stdout);
    assert.deepEqual(plan.skipped, []);
  });
});

describe('typecheck run', { skip: !hasTsc && 'typescript is not installed' }, () => {
  it('fresh worktree: no dist anywhere, exits 0 and does not report the unresolved import', () => {
    workspace([
      { dir: 'lib', name: '@f/lib', src: OK },
      { dir: 'app', name: '@f/app', deps: ['@f/lib'], src: NEEDS_SIBLING },
    ]);
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /SKIPPED @f\/app/);
    assert.doesNotMatch(r.stderr, /TS2307|Cannot find module/);
  });

  it('still fails on a real type error in a package whose upstream dist IS present', () => {
    workspace([
      { dir: 'lib', name: '@f/lib', built: true, src: OK },
      { dir: 'app', name: '@f/app', deps: ['@f/lib'], src: TYPE_ERROR },
    ]);
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /TS2322/);
  });

  it('still fails on a real type error in a package with no workspace dependencies', () => {
    workspace([{ dir: 'solo', name: '@f/solo', src: TYPE_ERROR }]);
    assert.equal(run().status, 1);
  });

  it('a skipped package does not mask a real error in another package', () => {
    workspace([
      { dir: 'lib', name: '@f/lib', src: OK },
      { dir: 'app', name: '@f/app', deps: ['@f/lib'], src: NEEDS_SIBLING },
      { dir: 'solo', name: '@f/solo', src: TYPE_ERROR },
    ]);
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SKIPPED @f\/app/);
    assert.match(r.stderr, /TS2322/);
  });

  it('a clean workspace with all upstream dist present exits 0', () => {
    workspace([
      { dir: 'lib', name: '@f/lib', built: true, src: OK },
      { dir: 'app', name: '@f/app', deps: ['@f/lib'], src: OK },
    ]);
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /SKIPPED/);
  });
});

describe('wiring', () => {
  it('the husky pre-commit hook runs this runner instead of the strict recursive tsc', () => {
    const hook = readFileSync(join(REPO, '.husky', 'pre-commit'), 'utf-8');
    assert.match(hook, /^node scripts\/typecheck-workspace\.mjs$/m);
    assert.doesNotMatch(hook, /^pnpm typecheck$/m);
  });
});
