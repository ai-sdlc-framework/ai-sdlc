/**
 * Tests for `scripts/check-coverage.sh`.
 *
 * Section 1 — bypass env vars (AI_SDLC_BYPASS_ALL_GATES, AI_SDLC_SKIP_COVERAGE_GATE):
 *   Pure bash logic — no pnpm build or coverage data required.
 *
 * Section 2 — docs-only short-circuit (AC-1 / AISDLC-389):
 *   Feed synthetic pre-push stdin records and assert the script exits 0
 *   immediately when all changed files are docs-only.
 *
 * Section 3 — coverage threshold-walk scope (AC-4 / AISDLC-389):
 *   Build a hermetic git repo + coverage-summary.json fixtures and assert
 *   that only affected packages are walked (single-package vs cross-cutting).
 *
 * Run with: node --test scripts/check-coverage.test.mjs
 */

import { describe, it, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  realpathSync,
} from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-coverage.sh');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.AI_SDLC_BYPASS_ALL_GATES;
  delete env.AI_SDLC_SKIP_COVERAGE_GATE;
  delete env.AI_SDLC_COVERAGE_THRESHOLD;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

function runScript(cwd, envOverrides = {}, stdinData = '') {
  return spawnSync('bash', [SCRIPT], {
    cwd,
    env: cleanEnv(envOverrides),
    encoding: 'utf-8',
    input: stdinData,
  });
}

// ── Section 1: bypass env vars ────────────────────────────────────────────────

describe('check-coverage.sh — bypass env vars', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-coverage-gate-'));
    chmodSync(SCRIPT, 0o755);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 0 immediately when AI_SDLC_BYPASS_ALL_GATES=1', () => {
    // Even with no pnpm / no coverage data at all, master bypass exits 0.
    const r = runScript(tmpDir, { AI_SDLC_BYPASS_ALL_GATES: '1' });
    assert.equal(
      r.status,
      0,
      `expected exit 0, got ${r.status}. stderr: ${r.stderr} stdout: ${r.stdout}`,
    );
    assert.match(r.stderr, /AI_SDLC_BYPASS_ALL_GATES=1/);
  });

  it('does NOT bypass when AI_SDLC_BYPASS_ALL_GATES is unset', () => {
    // Without the bypass, the script tries to run pnpm test:coverage which will
    // fail in the temp dir (no pnpm, no workspace). We just verify the bypass
    // logic doesn't fire — exit should be non-zero (the build/coverage step fails).
    const r = runScript(tmpDir, { AI_SDLC_BYPASS_ALL_GATES: '0' });
    // Should NOT have the bypass message in stderr.
    assert.doesNotMatch(r.stderr ?? '', /AI_SDLC_BYPASS_ALL_GATES=1/);
    // Script should not exit 0 because coverage cannot pass in a scratch dir.
    assert.notEqual(r.status, 0, 'expected non-zero exit (no pnpm workspace) when bypass not set');
  });

  it('exits 0 immediately when AI_SDLC_SKIP_COVERAGE_GATE=1 (per-gate skip still works)', () => {
    const r = runScript(tmpDir, { AI_SDLC_SKIP_COVERAGE_GATE: '1' });
    assert.equal(
      r.status,
      0,
      `expected exit 0, got ${r.status}. stderr: ${r.stderr} stdout: ${r.stdout}`,
    );
    // Per-gate skip message appears in stdout (not stderr — matches existing script output)
    assert.match(r.stdout + r.stderr, /AI_SDLC_SKIP_COVERAGE_GATE=1/);
  });

  it('AI_SDLC_BYPASS_ALL_GATES=1 takes precedence over AI_SDLC_SKIP_COVERAGE_GATE=0', () => {
    // Both set — bypass wins because it's checked first.
    const r = runScript(tmpDir, {
      AI_SDLC_BYPASS_ALL_GATES: '1',
      AI_SDLC_SKIP_COVERAGE_GATE: '0',
    });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /AI_SDLC_BYPASS_ALL_GATES=1/);
  });
});

// ── Section 2: docs-only short-circuit (AC-1 / AISDLC-389) ──────────────────

describe('check-coverage.sh — docs-only short-circuit (AC-1)', () => {
  // We build a real hermetic git repo so the script can run `git diff --name-only`
  // and `node scripts/is-docs-only-changeset.mjs` against actual commit history.
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-coverage-docs-only-'));
    tmpDir = realpathSync(tmpDir);
    chmodSync(SCRIPT, 0o755);

    const gitOpts = { cwd: tmpDir, encoding: 'utf-8' };
    execFileSync('git', ['init', '-b', 'main'], gitOpts);
    execFileSync('git', ['config', 'user.name', 'Test'], gitOpts);
    execFileSync('git', ['config', 'user.email', 'test@test.com'], gitOpts);

    // Initial commit (origin/main reference point)
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'root' }));
    execFileSync('git', ['add', 'package.json'], gitOpts);
    execFileSync('git', ['commit', '-m', 'chore: initial commit'], gitOpts);

    // Tag this as "remote/main" so the diff base works
    execFileSync('git', ['branch', '-M', 'main'], gitOpts);
    // Create a fake origin/main ref pointing to HEAD
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], gitOpts);

    // Second commit — docs-only change
    mkdirSync(join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(join(tmpDir, 'docs/NOTES.md'), '# Notes\n');
    execFileSync('git', ['add', 'docs/NOTES.md'], gitOpts);
    execFileSync('git', ['commit', '-m', 'docs: add notes'], gitOpts);
  });

  after(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it('exits 0 and prints docs-only message when all changed files are docs-only', () => {
    // Get the current HEAD SHA and origin/main SHA for the pre-push stdin record.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: tmpDir,
      encoding: 'utf-8',
    }).trim();
    const originMain = execFileSync('git', ['rev-parse', 'refs/remotes/origin/main'], {
      cwd: tmpDir,
      encoding: 'utf-8',
    }).trim();

    // Simulate the pre-push stdin format: "<local-ref> <local-sha> <remote-ref> <remote-sha>"
    const stdinRecord = `refs/heads/main ${head} refs/remotes/origin/main ${originMain}\n`;

    const r = runScript(tmpDir, { AI_SDLC_BYPASS_ALL_GATES: '0' }, stdinRecord);

    assert.equal(
      r.status,
      0,
      `expected exit 0 (docs-only skip), got ${r.status}.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.match(
      r.stdout + r.stderr,
      /docs-only changeset — skipping/,
      'expected docs-only skip message in output',
    );
  });
});

// ── Section 3: coverage threshold-walk scope (AC-4 / AISDLC-389) ─────────────

describe('check-coverage.sh — coverage threshold-walk scope (AC-4)', () => {
  // This section tests that the coverage-summary.json walk only visits packages
  // in the affected set. We stub out pnpm by injecting a fake `pnpm` script in
  // PATH that:
  //   - On `--filter "...[origin/main]" build` → exits 0 (success)
  //   - On `--filter "...[origin/main]" test:coverage` → exits 0 (success)
  //   - On `--filter "...[origin/main]" list --json --depth -1` → returns a
  //     JSON array with only the affected package(s)
  // Then we place coverage-summary.json fixtures at both packages and assert
  // the walk log only mentions the affected package.

  let tmpDir;
  let pkgADir;
  let pkgBDir;

  // Helpers to write a passing or failing coverage-summary.json
  function writeCoverageSummary(pkgDir, pct) {
    const covDir = join(pkgDir, 'coverage');
    mkdirSync(covDir, { recursive: true });
    writeFileSync(
      join(covDir, 'coverage-summary.json'),
      JSON.stringify({
        total: { lines: { pct } },
      }),
    );
  }

  function writeFakePnpm(binDir, affectedPkgPath) {
    // Fake pnpm script that handles the commands the coverage script calls.
    const script = `#!/usr/bin/env bash
set -euo pipefail
ARGS=("$@")
# Detect the command pattern and respond appropriately.
CMD_STR="${'${ARGS[*]}'}"
if [[ "$CMD_STR" == *"list"*"--json"* ]]; then
  # Return a JSON array listing only the affected package
  printf '[{"name":"pkg-a","version":"1.0.0","path":"%s"}]\\n' "${affectedPkgPath}"
  exit 0
fi
if [[ "$CMD_STR" == *"build"* ]] || [[ "$CMD_STR" == *"test:coverage"* ]]; then
  exit 0
fi
# Unknown command — passthrough to real pnpm if available, else fail
exit 0
`;
    mkdirSync(binDir, { recursive: true });
    const fakePnpm = join(binDir, 'pnpm');
    writeFileSync(fakePnpm, script);
    chmodSync(fakePnpm, 0o755);
    return fakePnpm;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-coverage-scope-'));
    tmpDir = realpathSync(tmpDir);
    chmodSync(SCRIPT, 0o755);

    // Create two fake packages
    pkgADir = join(tmpDir, 'pkg-a');
    pkgBDir = join(tmpDir, 'pkg-b');
    mkdirSync(pkgADir, { recursive: true });
    mkdirSync(pkgBDir, { recursive: true });
    writeFileSync(join(pkgADir, 'package.json'), JSON.stringify({ name: 'pkg-a' }));
    writeFileSync(join(pkgBDir, 'package.json'), JSON.stringify({ name: 'pkg-b' }));

    // Create a scripts/ dir with the is-docs-only-changeset.mjs symlink so
    // the script can find it relative to ROOT.
    const scriptsDir = join(tmpDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    // Copy the real is-docs-only-changeset.mjs into the temp dir's scripts/
    const realScript = join(__dirname, 'is-docs-only-changeset.mjs');
    const scriptContent = readFileSync(realScript, 'utf-8');
    writeFileSync(join(scriptsDir, 'is-docs-only-changeset.mjs'), scriptContent);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('single-package push — only that package coverage is walked', () => {
    // Both packages have coverage files, but pnpm filter only returns pkg-a.
    // AI_SDLC_WORKSPACE_ROOT is set so `find` scans tmpDir, not the real repo.
    writeCoverageSummary(pkgADir, 90);
    writeCoverageSummary(pkgBDir, 90);

    const binDir = join(tmpDir, '.fake-bin');
    writeFakePnpm(binDir, pkgADir);

    const r = runScript(
      tmpDir,
      {
        AI_SDLC_BYPASS_ALL_GATES: '0',
        AI_SDLC_SKIP_COVERAGE_GATE: '0',
        AI_SDLC_WORKSPACE_ROOT: tmpDir,
        PATH: `${binDir}:${process.env.PATH}`,
      },
      // No stdin → docs-only check reads empty stdin, LOCAL_SHA empty → skipped
      '',
    );

    // The walk should mention pkg-a but NOT pkg-b.
    const output = r.stdout + r.stderr;
    assert.match(output, /pkg-a/, 'expected pkg-a to appear in coverage walk output');
    assert.doesNotMatch(output, /pkg-b/, 'expected pkg-b to be absent from coverage walk output');
  });

  it('cross-cutting push — all packages walked (pnpm returns all packages)', () => {
    // Simulate a cross-cutting push: fake pnpm returns both packages.
    // AI_SDLC_WORKSPACE_ROOT is set so `find` scans tmpDir, not the real repo.
    writeCoverageSummary(pkgADir, 90);
    writeCoverageSummary(pkgBDir, 90);

    const binDir = join(tmpDir, '.fake-bin-cross');
    mkdirSync(binDir, { recursive: true });

    // Fake pnpm that returns both packages on list --json
    const script = `#!/usr/bin/env bash
set -euo pipefail
CMD_STR="$*"
if [[ "$CMD_STR" == *"list"*"--json"* ]]; then
  printf '[{"name":"pkg-a","version":"1.0.0","path":"${pkgADir}"},{"name":"pkg-b","version":"1.0.0","path":"${pkgBDir}"}]\\n'
  exit 0
fi
exit 0
`;
    const fakePnpm = join(binDir, 'pnpm');
    writeFileSync(fakePnpm, script);
    chmodSync(fakePnpm, 0o755);

    const r = runScript(
      tmpDir,
      {
        AI_SDLC_BYPASS_ALL_GATES: '0',
        AI_SDLC_SKIP_COVERAGE_GATE: '0',
        AI_SDLC_WORKSPACE_ROOT: tmpDir,
        PATH: `${binDir}:${process.env.PATH}`,
      },
      '',
    );

    // Both packages should appear in coverage walk output.
    const output = r.stdout + r.stderr;
    assert.match(output, /pkg-a/, 'expected pkg-a to appear in coverage walk output');
    assert.match(output, /pkg-b/, 'expected pkg-b to appear in coverage walk output');
  });
});

describe('check-coverage.sh — foundation filter args (AISDLC-390 AC-2)', () => {
  // Regression guard for AISDLC-390: the pre-coverage build MUST include the
  // three foundation packages (@ai-sdlc/orchestrator, @ai-sdlc/pipeline-cli,
  // @ai-sdlc/reference) as always-on --filter args. Without these, pnpm's
  // affected-package filter selects dependents of changed packages but skips
  // those dependents' own foundation deps (the AISDLC-385 stopgap class).
  //
  // The check is a string match on the script content, NOT a runtime
  // execution — the runtime contract (`pnpm --filter "...[origin/main]"
  // --filter @ai-sdlc/orchestrator ...`) is opaque to a hermetic shell
  // simulator; pnpm itself is the union-of-filters engine. Asserting the
  // literal filter args in the script is the closest mechanical guard.

  it('pre-coverage build includes orchestrator/pipeline-cli/reference foundation filters', () => {
    const SCRIPT = readFileSync(
      join(import.meta.dirname, 'check-coverage.sh'),
      'utf-8',
    );
    // The build invocation must reference all three foundation packages.
    assert.match(SCRIPT, /--filter "@ai-sdlc\/orchestrator"/, 'orchestrator missing');
    assert.match(SCRIPT, /--filter "@ai-sdlc\/pipeline-cli"/, 'pipeline-cli missing');
    assert.match(SCRIPT, /--filter "@ai-sdlc\/reference"/, 'reference missing');
    // And the affected-set filter must still be present.
    assert.match(
      SCRIPT,
      /--filter "\.\.\.\[origin\/main\]"/,
      'affected-set filter ...[origin/main] missing',
    );
  });

  it('CI workflow Build step includes the same foundation filters (symmetry with check-coverage.sh)', () => {
    // Symmetry guard: the CI Build & Test job MUST use the same filter set as
    // the local pre-push coverage gate. If they diverge, a regression that
    // re-introduces TS2307 could pass local pre-push (because the local script
    // builds foundations) but fail CI (because ci.yml doesn't). The single
    // root cause this PR fixes lives in BOTH files; the regression guard
    // must too.
    const WORKFLOW = readFileSync(
      join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'),
      'utf-8',
    );
    assert.match(WORKFLOW, /--filter "@ai-sdlc\/orchestrator"/, 'orchestrator missing in ci.yml');
    assert.match(WORKFLOW, /--filter "@ai-sdlc\/pipeline-cli"/, 'pipeline-cli missing in ci.yml');
    assert.match(WORKFLOW, /--filter "@ai-sdlc\/reference"/, 'reference missing in ci.yml');
    assert.match(
      WORKFLOW,
      /--filter "\.\.\.\[origin\/main\]"/,
      'affected-set filter ...[origin/main] missing in ci.yml',
    );
  });
});
