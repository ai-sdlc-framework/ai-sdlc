/**
 * Tests for `scripts/check-coverage.sh`.
 *
 * Focuses on the env-var bypass paths (AI_SDLC_BYPASS_ALL_GATES and
 * AI_SDLC_SKIP_COVERAGE_GATE) which are pure bash logic — no pnpm
 * build or coverage data required. The full coverage-threshold path
 * is exercised by running pnpm test:coverage in CI against real data.
 *
 * Run with: node --test scripts/check-coverage.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

function runScript(cwd, envOverrides = {}) {
  return spawnSync('bash', [SCRIPT], {
    cwd,
    env: cleanEnv(envOverrides),
    encoding: 'utf-8',
  });
}

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
