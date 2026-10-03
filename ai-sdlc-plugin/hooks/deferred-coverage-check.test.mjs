// Hermetic tests for deferred-coverage-check.js loop-prevention.
//
// The hook fires on every Stop event. Without dedup it re-wakes the model
// indefinitely whenever a test fails — witnessed in the wild as an
// infinite Stop-hook loop on a session that wasn't even working in this
// repo. These tests pin the dedup contract so the regression doesn't
// re-introduce.
//
// Each test sets up a temp git repo + temp $HOME (sentinel location) +
// invokes the hook via execFile, asserts exit code + sentinel state.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, 'deferred-coverage-check.js');

function sh(cmd, opts = {}) {
  return execFileSync('bash', ['-c', cmd], { encoding: 'utf-8', ...opts }).trim();
}

function setupRepo(coverageBehavior) {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-coverage-hook-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(repo);
  mkdirSync(home);

  // Init git + first commit (HEAD must exist for `git rev-parse HEAD`)
  sh('git init -q', { cwd: repo });
  sh('git config user.email test@test.invalid', { cwd: repo });
  sh('git config user.name Test', { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# test\n');
  sh('git add README.md && git commit -q -m initial', { cwd: repo });

  // package.json declaring vitest + coverage-v8 (so the dep gate passes)
  // and a `test:coverage` script we control via the test fixture.
  const coverageScript =
    coverageBehavior === 'pass'
      ? 'echo "All files |  90.00 |"; exit 0'
      : coverageBehavior === 'low-coverage'
        ? 'echo "All files |  45.00 |"; exit 1'
        : coverageBehavior === 'test-fail'
          ? 'echo "FAIL src/foo.test.ts" 1>&2; echo "1 failed" 1>&2; exit 1'
          : 'exit 0';
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify(
      {
        name: 'test-fixture',
        scripts: { 'test:coverage': coverageScript },
        devDependencies: { vitest: '^1.0.0', '@vitest/coverage-v8': '^1.0.0' },
      },
      null,
      2,
    ),
  );

  // Add an uncommitted .ts file so the source-modified gate passes
  writeFileSync(join(repo, 'src.ts'), 'export const x = 1;\n');

  // pnpm-lock.yaml so the script picks `pnpm test:coverage`. We stub
  // `pnpm` to invoke our `test:coverage` script directly via bash.
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 5.4\n');

  // Stub pnpm: run the script from package.json via bash. Put it on PATH
  // by creating a shim dir + prepending to PATH.
  const shim = join(root, 'shim');
  mkdirSync(shim);
  writeFileSync(
    join(shim, 'pnpm'),
    `#!/bin/bash
# Test stub — executes the test:coverage script from package.json
SCRIPT=$(node -e "console.log(require('./package.json').scripts['test:coverage'])")
bash -c "$SCRIPT"
`,
    { mode: 0o755 },
  );

  return { root, repo, home, shim };
}

function runHook({ repo, home, shim, root }) {
  const res = spawnSync('node', [HOOK], {
    cwd: repo,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      AI_SDLC_COVERAGE_LOCK_DIR: join(root, 'lock'),
      CLAUDE_PROJECT_DIR: repo,
      PATH: `${shim}:${process.env.PATH}`,
    },
    input: JSON.stringify({}), // hook reads stdin as JSON
  });
  return { exitCode: res.status, stderr: res.stderr, stdout: res.stdout };
}

function sentinelPath(home, repo) {
  const repoHash = createHash('sha256').update(repo).digest('hex').slice(0, 12);
  return join(home, '.claude', 'ai-sdlc', `coverage-failure-${repoHash}.json`);
}

let ctx;

afterEach(() => {
  if (ctx) rmSync(ctx.root, { recursive: true, force: true });
  ctx = null;
});

describe('deferred-coverage-check.js — loop prevention', () => {
  it('exits 2 with new sentinel on first failure', () => {
    ctx = setupRepo('low-coverage');
    const res = runHook(ctx);
    assert.equal(res.exitCode, 2, `expected exit 2, got ${res.exitCode}\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /AI-SDLC Coverage: 45/);
    assert.equal(existsSync(sentinelPath(ctx.home, ctx.repo)), true, 'sentinel should be written');
  });

  it('exits 0 on identical re-run (loop-prevention)', () => {
    ctx = setupRepo('low-coverage');
    // First invocation — exits 2, writes sentinel.
    const first = runHook(ctx);
    assert.equal(first.exitCode, 2);

    // Second invocation, same HEAD + same failure — should NOT re-wake.
    const second = runHook(ctx);
    assert.equal(second.exitCode, 0, `loop-prevention failed; second exit was ${second.exitCode}`);
    assert.match(second.stderr, /same failure as previous turn/);
  });

  it('exits 2 again when HEAD changes (new commit clears the dedup)', () => {
    ctx = setupRepo('low-coverage');
    runHook(ctx); // primes sentinel

    // Simulate a new commit landing — different HEAD SHA
    sh('git add src.ts && git commit -q -m change', { cwd: ctx.repo });
    writeFileSync(join(ctx.repo, 'src.ts'), 'export const x = 2;\n'); // re-dirty

    const res = runHook(ctx);
    assert.equal(res.exitCode, 2, 'new HEAD should re-wake the model');
  });

  it('clears sentinel on test success', () => {
    ctx = setupRepo('low-coverage');
    runHook(ctx); // primes sentinel
    assert.equal(existsSync(sentinelPath(ctx.home, ctx.repo)), true);

    // Swap to passing coverage and re-run
    const pkg = JSON.parse(readFileSync(join(ctx.repo, 'package.json'), 'utf-8'));
    pkg.scripts['test:coverage'] = 'echo "All files |  90.00 |"; exit 0';
    writeFileSync(join(ctx.repo, 'package.json'), JSON.stringify(pkg, null, 2));

    const res = runHook(ctx);
    assert.equal(res.exitCode, 0);
    assert.equal(
      existsSync(sentinelPath(ctx.home, ctx.repo)),
      false,
      'sentinel should be cleared after test success',
    );
  });

  it('exits 2 on test failure (non-coverage path)', () => {
    ctx = setupRepo('test-fail');
    const res = runHook(ctx);
    assert.equal(res.exitCode, 2);
    assert.match(res.stderr, /Tests? fail/i);
    assert.equal(existsSync(sentinelPath(ctx.home, ctx.repo)), true);
  });

  it('exits 0 on identical test-failure re-run (loop-prevention)', () => {
    ctx = setupRepo('test-fail');
    runHook(ctx); // primes sentinel
    const second = runHook(ctx);
    assert.equal(second.exitCode, 0);
    assert.match(second.stderr, /same test failure as previous turn/);
  });
});

describe('deferred-coverage-check.js — source-change scope', () => {
  it('exits 0 when no source files are modified (uncommitted)', () => {
    ctx = setupRepo('low-coverage');
    // Remove the staged .ts file so git status shows no source changes
    rmSync(join(ctx.repo, 'src.ts'));
    const res = runHook(ctx);
    assert.equal(res.exitCode, 0, 'should not run coverage when nothing modified');
  });

  it('exits 0 on docs-only modification (e.g. uncommitted .md)', () => {
    ctx = setupRepo('low-coverage');
    // Replace the .ts file with a .md file
    rmSync(join(ctx.repo, 'src.ts'));
    writeFileSync(join(ctx.repo, 'NOTES.md'), '# notes\n');
    const res = runHook(ctx);
    assert.equal(res.exitCode, 0, 'docs-only changes should not fire coverage');
  });

  it('detects source files inside an untracked DIRECTORY (round-1 fix)', () => {
    // Without --untracked-files=all, `git status --porcelain` reports an
    // untracked dir as a single line `?? src/new/` and the `.ts` filter
    // misses every file inside. This regression test pins the fix.
    ctx = setupRepo('low-coverage');
    rmSync(join(ctx.repo, 'src.ts'));
    mkdirSync(join(ctx.repo, 'src', 'new-feature'), { recursive: true });
    writeFileSync(join(ctx.repo, 'src', 'new-feature', 'thing.ts'), 'export const y = 2;\n');
    const res = runHook(ctx);
    assert.equal(res.exitCode, 2, 'untracked dir with .ts files should trigger coverage');
  });

  it('handles renamed (R) source files', () => {
    ctx = setupRepo('low-coverage');
    // Stage a rename: existing src.ts → src/renamed.ts
    sh('git add src.ts && git commit -q -m add-src', { cwd: ctx.repo });
    mkdirSync(join(ctx.repo, 'src'));
    sh('git mv src.ts src/renamed.ts', { cwd: ctx.repo });
    const res = runHook(ctx);
    assert.equal(res.exitCode, 2, 'renamed .ts file should trigger coverage');
  });

  it('handles tracked-modified .ts file (M status)', () => {
    ctx = setupRepo('low-coverage');
    sh('git add src.ts && git commit -q -m add-src', { cwd: ctx.repo });
    writeFileSync(join(ctx.repo, 'src.ts'), 'export const x = 99;\n');
    const res = runHook(ctx);
    assert.equal(res.exitCode, 2, 'tracked-modified .ts file should trigger coverage');
  });

  it('handles deleted .ts file (D status)', () => {
    ctx = setupRepo('low-coverage');
    sh('git add src.ts && git commit -q -m add-src', { cwd: ctx.repo });
    rmSync(join(ctx.repo, 'src.ts'));
    const res = runHook(ctx);
    assert.equal(res.exitCode, 2, 'deleted .ts file should trigger coverage');
  });
});

describe('deferred-coverage-check.js — sentinel robustness', () => {
  it('falls back to waking on a corrupt sentinel (invalid JSON)', () => {
    ctx = setupRepo('low-coverage');
    // Pre-create a corrupt sentinel
    const sPath = sentinelPath(ctx.home, ctx.repo);
    mkdirSync(dirname(sPath), { recursive: true });
    writeFileSync(sPath, 'not json {{{');

    const res = runHook(ctx);
    assert.equal(res.exitCode, 2, 'corrupt sentinel should fall through to first-failure path');
    // Verify the sentinel got rewritten with valid JSON
    const after = JSON.parse(readFileSync(sPath, 'utf-8'));
    assert.ok(after.head, 'sentinel should be rewritten with head');
    assert.ok(after.fingerprint, 'sentinel should be rewritten with fingerprint');
  });
});

// ── AISDLC-685: single-flight, scoped, group-killed ─────────────────

const LOCK_NAME = 'ai-sdlc-deferred-coverage.lock';

// Workspace fixture: two packages + a recording `pnpm` shim. No real
// coverage ever runs; the shim logs its args (one line per invocation) and
// can sleep while holding a grandchild to exercise group killing.
function setupWorkspace({ maxDurationMs } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-coverage-ws-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  const shim = join(root, 'shim');
  const lock = join(root, 'lock');
  for (const d of [repo, home, shim, lock]) mkdirSync(d);
  sh('git init -q', { cwd: repo });
  sh('git config user.email test@test.invalid', { cwd: repo });
  sh('git config user.name Test', { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# test\n');
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 5.4\n');
  writeFileSync(join(repo, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({
      name: 'ws-root',
      scripts: { 'test:coverage': 'pnpm -r test:coverage' },
      devDependencies: { vitest: '^1.0.0', '@vitest/coverage-v8': '^1.0.0' },
    }),
  );
  for (const n of ['a', 'b']) {
    mkdirSync(join(repo, 'packages', n, 'src'), { recursive: true });
    writeFileSync(
      join(repo, 'packages', n, 'package.json'),
      JSON.stringify({ name: `@t/${n}`, scripts: { 'test:coverage': 'vitest run --coverage' } }),
    );
  }
  if (maxDurationMs) {
    mkdirSync(join(repo, '.ai-sdlc'));
    writeFileSync(
      join(repo, '.ai-sdlc', 'coverage-config.yaml'),
      `maxDurationMs: ${maxDurationMs}\n`,
    );
  }
  sh('git add -A && git commit -q -m initial', { cwd: repo });
  const log = join(root, 'shim.log');
  writeFileSync(
    join(shim, 'pnpm'),
    `#!/bin/bash
echo "$*" >> "${log}"
echo "WORKERS=$AI_SDLC_VITEST_MAX_WORKERS" >> "${log}.env"
if [ -n "$SHIM_SLEEP" ]; then
  sleep 300 &
  echo $! >> "${log}.gc"
  sleep "$SHIM_SLEEP"
fi
exit 0
`,
    { mode: 0o755 },
  );
  return { root, repo, home, shim, lock, log };
}

function hookEnv(w, extra = {}) {
  return {
    ...process.env,
    HOME: w.home,
    CLAUDE_PROJECT_DIR: w.repo,
    AI_SDLC_COVERAGE_LOCK_DIR: w.lock,
    PATH: `${w.shim}:${process.env.PATH}`,
    ...extra,
  };
}

function runWs(w, extra) {
  return spawnSync('node', [HOOK], {
    cwd: w.repo,
    encoding: 'utf-8',
    env: hookEnv(w, extra),
    input: '{}', // stdin via pipe, never /dev/stdin
  });
}

function startHook(w, extra) {
  const c = spawn('node', [HOOK], {
    cwd: w.repo,
    env: hookEnv(w, extra),
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  c.stdin.end('{}');
  return new Promise((res) => c.on('exit', (code) => res(code)));
}

function invocations(w) {
  return existsSync(w.log) ? readFileSync(w.log, 'utf-8').split('\n').filter(Boolean) : [];
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function deadPid() {
  return spawnSync('node', ['-e', '']).pid;
}

describe('deferred-coverage-check.js — single-flight / scope / reaping (AISDLC-685)', () => {
  let w;
  afterEach(() => {
    if (w) {
      // clean up grandchildren spawned by our own shim
      const gc = `${w.log}.gc`;
      if (existsSync(gc)) {
        for (const p of readFileSync(gc, 'utf-8').split('\n').filter(Boolean)) {
          try {
            process.kill(Number(p), 'SIGKILL');
          } catch {
            /* gone */
          }
        }
      }
      rmSync(w.root, { recursive: true, force: true });
    }
    w = null;
  });

  it('two hooks started together result in exactly one coverage run', async () => {
    w = setupWorkspace();
    writeFileSync(join(w.repo, 'packages', 'a', 'src', 'x.ts'), 'export const x = 1;\n');
    const codes = await Promise.all([
      startHook(w, { SHIM_SLEEP: '1' }),
      startHook(w, { SHIM_SLEEP: '1' }),
    ]);
    assert.deepEqual(codes, [0, 0]);
    assert.equal(invocations(w).length, 1);
    assert.equal(existsSync(join(w.lock, LOCK_NAME)), false, 'lock released');
  });

  it('a live lock holder makes the hook exit 0 silently without running', () => {
    w = setupWorkspace();
    writeFileSync(join(w.repo, 'packages', 'a', 'src', 'x.ts'), 'export const x = 1;\n');
    writeFileSync(
      join(w.lock, LOCK_NAME),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
    );
    const res = runWs(w);
    assert.equal(res.status, 0);
    assert.equal(res.stderr, '');
    assert.equal(invocations(w).length, 0);
  });

  it('takes over a stale lock (dead pid) and releases it afterwards', () => {
    w = setupWorkspace();
    writeFileSync(join(w.repo, 'packages', 'a', 'src', 'x.ts'), 'export const x = 1;\n');
    writeFileSync(
      join(w.lock, LOCK_NAME),
      JSON.stringify({ pid: deadPid(), startedAt: Date.now() }),
    );
    const res = runWs(w);
    assert.equal(res.status, 0);
    assert.equal(invocations(w).length, 1);
    assert.equal(existsSync(join(w.lock, LOCK_NAME)), false);
  });

  it('takes over a lock whose pid is alive but far older than the max duration (pid reuse)', () => {
    w = setupWorkspace();
    writeFileSync(join(w.repo, 'packages', 'a', 'src', 'x.ts'), 'export const x = 1;\n');
    writeFileSync(
      join(w.lock, LOCK_NAME),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() - 3 * 3600 * 1000 }),
    );
    assert.equal(runWs(w).status, 0);
    assert.equal(invocations(w).length, 1);
  });

  it('two hooks racing over the same stale lock: exactly one proceeds', async () => {
    w = setupWorkspace();
    writeFileSync(join(w.repo, 'packages', 'a', 'src', 'x.ts'), 'export const x = 1;\n');
    writeFileSync(
      join(w.lock, LOCK_NAME),
      JSON.stringify({ pid: deadPid(), startedAt: Date.now() }),
    );
    await Promise.all([startHook(w, { SHIM_SLEEP: '1' }), startHook(w, { SHIM_SLEEP: '1' })]);
    assert.equal(invocations(w).length, 1);
  });

  it('after a forced timeout no process of the group is alive within 5s; lock released', async () => {
    w = setupWorkspace({ maxDurationMs: 700 });
    writeFileSync(join(w.repo, 'packages', 'a', 'src', 'x.ts'), 'export const x = 1;\n');
    const code = await startHook(w, { SHIM_SLEEP: '120' });
    assert.equal(code, 0, 'timeout exits 0 (advisory)');
    const gcs = readFileSync(`${w.log}.gc`, 'utf-8').split('\n').filter(Boolean).map(Number);
    assert.ok(gcs.length >= 1, 'shim spawned a grandchild');
    const end = Date.now() + 5000;
    while (Date.now() < end && gcs.some(alive)) await sleepMs(100);
    assert.deepEqual(gcs.filter(alive), [], 'grandchildren must be dead');
    assert.equal(existsSync(join(w.lock, LOCK_NAME)), false, 'lock released after timeout');
  });

  it('a dirty file in one package runs that package only', () => {
    w = setupWorkspace();
    writeFileSync(join(w.repo, 'packages', 'a', 'src', 'x.ts'), 'export const x = 1;\n');
    assert.equal(runWs(w).status, 0);
    const calls = invocations(w);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /--filter @t\/a /);
    assert.doesNotMatch(calls[0], /@t\/b/);
    assert.doesNotMatch(calls[0], /-r\b/);
  });

  it('dirty files in two packages pass one --filter per package', () => {
    w = setupWorkspace();
    writeFileSync(join(w.repo, 'packages', 'a', 'src', 'x.ts'), 'export const x = 1;\n');
    writeFileSync(join(w.repo, 'packages', 'b', 'src', 'y.ts'), 'export const y = 1;\n');
    assert.equal(runWs(w).status, 0);
    const calls = invocations(w);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /--filter @t\/a --filter @t\/b /);
  });

  it('an unmappable dirty path (workspace root file) skips with zero invocations', () => {
    w = setupWorkspace();
    mkdirSync(join(w.repo, 'scripts'));
    writeFileSync(join(w.repo, 'scripts', 'tool.js'), 'module.exports = 1;\n');
    assert.equal(runWs(w).status, 0);
    assert.equal(invocations(w).length, 0, 'never falls back to workspace-wide');
  });

  it('single-package repo (root package, no workspaces) still runs the root command', () => {
    w = setupWorkspace();
    rmSync(join(w.repo, 'pnpm-workspace.yaml'));
    writeFileSync(join(w.repo, 'top.ts'), 'export const t = 1;\n');
    assert.equal(runWs(w).status, 0);
    assert.deepEqual(invocations(w), ['test:coverage']);
  });

  it('AI_SDLC_SKIP_DEFERRED_COVERAGE=1 runs nothing (even without stdin)', () => {
    w = setupWorkspace();
    writeFileSync(join(w.repo, 'packages', 'a', 'src', 'x.ts'), 'export const x = 1;\n');
    const res = spawnSync('node', [HOOK], {
      cwd: w.repo,
      encoding: 'utf-8',
      env: hookEnv(w, { AI_SDLC_SKIP_DEFERRED_COVERAGE: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(res.status, 0);
    assert.equal(invocations(w).length, 0);
    assert.equal(existsSync(join(w.lock, LOCK_NAME)), false);
  });

  it('child env sets AI_SDLC_VITEST_MAX_WORKERS=2', () => {
    w = setupWorkspace();
    writeFileSync(join(w.repo, 'packages', 'a', 'src', 'x.ts'), 'export const x = 1;\n');
    assert.equal(runWs(w, { AI_SDLC_VITEST_MAX_WORKERS: '9' }).status, 0);
    assert.equal(readFileSync(`${w.log}.env`, 'utf-8').trim(), 'WORKERS=2');
  });
});
