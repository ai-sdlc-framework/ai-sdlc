// AISDLC-137: hermetic tests for scripts/check-orchestrator-state.sh.
//
// Each test sets up a temp git repo + tmp "remote" repo + invokes the script
// via execFileSync, asserting exit code + post-state. Mirrors the pattern in
// check-attestation-sign.test.mjs / check-coverage.sh tests.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-orchestrator-state.sh');

function sh(cmd, opts = {}) {
  return execFileSync('bash', ['-c', cmd], { encoding: 'utf8', ...opts }).trim();
}

function setupRepoPair() {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-orchestrator-state-'));
  const remote = join(root, 'remote.git');
  const local = join(root, 'local');
  mkdirSync(remote);
  mkdirSync(local);

  // Init bare remote
  sh(`git init --bare -b main "${remote}"`);

  // Init local + first commit on main
  sh(`git init -b main "${local}"`);
  sh(`git -C "${local}" config user.email t@t.t && git -C "${local}" config user.name t`);
  sh(`git -C "${local}" config commit.gpgsign false`);
  writeFileSync(join(local, 'README.md'), 'initial\n');
  sh(`git -C "${local}" add README.md && git -C "${local}" commit -q -m initial`);
  sh(`git -C "${local}" remote add origin "${remote}"`);
  sh(`git -C "${local}" push -q -u origin main`);

  return { root, remote, local };
}

function runScript(cwd, env = {}) {
  try {
    const out = execFileSync('bash', [SCRIPT], {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    return { status: 0, stdout: out, stderr: '' };
  } catch (e) {
    return {
      status: e.status ?? 1,
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString(),
    };
  }
}

describe('check-orchestrator-state.sh', () => {
  let env;

  beforeEach(() => {
    env = setupRepoPair();
  });

  afterEach(() => {
    rmSync(env.root, { recursive: true, force: true });
  });

  it('no-op on clean state with main already current', () => {
    const r = runScript(env.local);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // No reset / no update messages expected
    assert.ok(!r.stdout.includes('resetting parent working tree'));
    assert.ok(!r.stdout.includes('updating refs/heads/main'));
  });

  it('auto-corrects core.bare=true to false', () => {
    sh(`git -C "${env.local}" config core.bare true`);
    const r = runScript(env.local);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /core\.bare=true detected; auto-correcting/);
    assert.equal(sh(`git -C "${env.local}" config --get core.bare`), 'false');
  });

  it('updates refs/heads/main when origin/main has moved', () => {
    // Simulate sibling commit on the remote by cloning, committing, pushing
    const sibling = join(env.root, 'sibling');
    sh(`git clone -q "${env.remote}" "${sibling}"`);
    sh(`git -C "${sibling}" config user.email s@s.s && git -C "${sibling}" config user.name s`);
    sh(`git -C "${sibling}" config commit.gpgsign false`);
    writeFileSync(join(sibling, 'sibling.txt'), 'sibling\n');
    sh(`git -C "${sibling}" add sibling.txt && git -C "${sibling}" commit -q -m sibling`);
    sh(`git -C "${sibling}" push -q origin main`);

    const beforeMain = sh(`git -C "${env.local}" rev-parse refs/heads/main`);

    const r = runScript(env.local);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // reset --hard implicitly moves refs/heads/main since HEAD is the symref
    assert.match(r.stdout, /resetting parent working tree/);

    // refs/heads/main should now match origin/main
    const afterMain = sh(`git -C "${env.local}" rev-parse refs/heads/main`);
    const originMain = sh(`git -C "${env.local}" rev-parse refs/remotes/origin/main`);
    assert.equal(afterMain, originMain);
    assert.notEqual(beforeMain, afterMain);

    // Working tree updated — sibling.txt should now exist
    assert.ok(existsSync(join(env.local, 'sibling.txt')));
  });

  it('aborts gracefully when working tree has uncommitted tracked changes', () => {
    // Move origin/main forward so the script needs to sync (otherwise it
    // short-circuits as already-up-to-date before reaching the dirty check).
    const sibling = join(env.root, 'sibling-dirty');
    sh(`git clone -q "${env.remote}" "${sibling}"`);
    sh(`git -C "${sibling}" config user.email s@s.s && git -C "${sibling}" config user.name s`);
    sh(`git -C "${sibling}" config commit.gpgsign false`);
    writeFileSync(join(sibling, 'sibling.txt'), 'sibling\n');
    sh(`git -C "${sibling}" add sibling.txt && git -C "${sibling}" commit -q -m sibling`);
    sh(`git -C "${sibling}" push -q origin main`);

    // NOW dirty the local tracked file
    writeFileSync(join(env.local, 'README.md'), 'modified\n');

    const r = runScript(env.local);
    // Exit 0 (gracefully skip), don't fail the script
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /uncommitted tracked changes; skipping reset/);
    assert.match(r.stdout, /Resolve manually/);

    // README.md must NOT be reverted
    assert.equal(sh(`cat "${join(env.local, 'README.md')}"`), 'modified');
  });

  it('skips entire check when AI_SDLC_SKIP_ORCHESTRATOR_STATE_CHECK=1', () => {
    sh(`git -C "${env.local}" config core.bare true`);
    const r = runScript(env.local, { AI_SDLC_SKIP_ORCHESTRATOR_STATE_CHECK: '1' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /skipped/);
    // core.bare should NOT have been corrected
    assert.equal(sh(`git -C "${env.local}" config --get core.bare`), 'true');
  });

  it('idempotent: second invocation is a no-op', () => {
    // First invocation may do work; second should be silent
    runScript(env.local);
    const r2 = runScript(env.local);
    assert.equal(r2.status, 0);
    assert.ok(!r2.stdout.includes('resetting parent working tree'));
    assert.ok(!r2.stdout.includes('updating refs/heads/main'));
    assert.ok(!r2.stdout.includes('auto-correcting'));
  });

  it('handles fetch failure gracefully (no remote)', () => {
    // Remove the origin remote so fetch fails
    sh(`git -C "${env.local}" remote remove origin`);
    const r = runScript(env.local);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /git fetch origin main failed/);
  });

  it('allows untracked files in the parent (does not block reset)', () => {
    // Add untracked file (simulates .worktrees/ or in-flight task draft)
    writeFileSync(join(env.local, 'untracked.txt'), 'untracked\n');

    // Move main forward to force a reset
    const sibling = join(env.root, 'sibling');
    sh(`git clone -q "${env.remote}" "${sibling}"`);
    sh(`git -C "${sibling}" config user.email s@s.s && git -C "${sibling}" config user.name s`);
    sh(`git -C "${sibling}" config commit.gpgsign false`);
    writeFileSync(join(sibling, 'sibling.txt'), 'sibling\n');
    sh(`git -C "${sibling}" add sibling.txt && git -C "${sibling}" commit -q -m sibling`);
    sh(`git -C "${sibling}" push -q origin main`);

    const r = runScript(env.local);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /resetting parent working tree/);
    // Untracked file must SURVIVE the reset
    assert.ok(existsSync(join(env.local, 'untracked.txt')), 'untracked file should survive reset');
  });
});
