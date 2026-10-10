/**
 * AISDLC-687: hermetic tests for `scripts/check-dark-code-on-push.sh`.
 *
 * Each case builds a throwaway git repo that carries a copy of the real checker and the
 * wrapper, plus a tiny `reference/src` tree (one of the checker's default source roots), and
 * runs the wrapper from inside it.
 *
 * Run with: node --test scripts/check-dark-code-on-push.test.mjs
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const WRAPPER = join(HERE, 'check-dark-code-on-push.sh');

let root;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function git(args) {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

/** files: { 'reference/src/x.ts': 'source' } */
function fixture(files) {
  root = mkdtempSync(join(tmpdir(), 'ai-sdlc-dark-gate-'));
  git(['init', '-q']);
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(HERE, 'check-dark-code.mjs'), join(root, 'scripts', 'check-dark-code.mjs'));
  copyFileSync(WRAPPER, join(root, 'scripts', 'check-dark-code-on-push.sh'));
  mkdirSync(join(root, '.ai-sdlc'));
  writeFileSync(
    join(root, '.ai-sdlc', 'dark-code-baseline.json'),
    JSON.stringify({
      allowlist: [],
      darkModules: [],
      stubAllowlist: [],
      stubSites: [],
    }),
  );
  for (const [path, src] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), src);
  }
}

const run = (env = {}) =>
  spawnSync('bash', [join(root, 'scripts', 'check-dark-code-on-push.sh')], {
    cwd: root,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    timeout: 60000,
  });

const WIRED = {
  'reference/src/index.ts': "export { used } from './used.js';\n",
  'reference/src/used.ts': 'export const used = 1;\n',
};
const DARK = {
  ...WIRED,
  'reference/src/orphan.ts': 'export const orphan = 2;\n',
};

describe('check-dark-code-on-push.sh', () => {
  it('passes when every module is wired', () => {
    fixture(WIRED);
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  it('blocks the push when a module is newly dark', () => {
    fixture(DARK);
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /orphan/);
    assert.match(r.stderr, /Push blocked/);
  });

  it('AI_SDLC_SKIP_DARK_CODE_GATE=1 skips the gate', () => {
    fixture(DARK);
    const r = run({ AI_SDLC_SKIP_DARK_CODE_GATE: '1' });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /AI_SDLC_SKIP_DARK_CODE_GATE=1/);
  });

  it('AI_SDLC_BYPASS_ALL_GATES=1 skips the gate', () => {
    fixture(DARK);
    const r = run({ AI_SDLC_BYPASS_ALL_GATES: '1' });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /AI_SDLC_BYPASS_ALL_GATES=1/);
  });

  it('runs from the repository root even when invoked from a subdirectory', () => {
    fixture(DARK);
    const r = spawnSync('bash', [join(root, 'scripts', 'check-dark-code-on-push.sh')], {
      cwd: join(root, 'reference', 'src'),
      encoding: 'utf-8',
      timeout: 60000,
    });
    assert.equal(r.status, 1);
  });
});

describe('pre-push wiring', () => {
  const hook = readFileSync(join(REPO, '.husky', 'pre-push'), 'utf-8');

  it('runs the dark-code gate and no local coverage gate (AISDLC-726)', () => {
    const dark = hook.indexOf('./scripts/check-dark-code-on-push.sh');
    assert.ok(dark > 0, 'dark-code gate is not in .husky/pre-push');
    assert.equal(
      hook.includes('check-coverage.sh'),
      false,
      'coverage is gated once, in CI; .husky/pre-push must not run it',
    );
  });
});
