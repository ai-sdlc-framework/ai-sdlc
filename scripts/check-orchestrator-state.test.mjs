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

  // AISDLC-358: branch-guard tests — four canonical cases.

  it('[AISDLC-358] parent on main, clean working tree → check passes', () => {
    // Already on main (default after setupRepoPair). No changes. Should pass silently.
    const r = runScript(env.local);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // No branch-recovery messages expected
    assert.ok(!r.stdout.includes('auto-recovered'), `unexpected recovery: ${r.stdout}`);
    assert.ok(
      !r.stdout.includes('ERROR: parent working tree is on branch'),
      `unexpected error: ${r.stdout}`,
    );
  });

  it('[AISDLC-358] parent on main, dirty working tree → warns + skips reset (existing AISDLC-137 behavior)', () => {
    // Move origin/main forward so the script needs to sync, then dirty local.
    const sibling = join(env.root, 'sibling-dirty2');
    sh(`git clone -q "${env.remote}" "${sibling}"`);
    sh(`git -C "${sibling}" config user.email s@s.s && git -C "${sibling}" config user.name s`);
    sh(`git -C "${sibling}" config commit.gpgsign false`);
    writeFileSync(join(sibling, 'sibling2.txt'), 'sibling2\n');
    sh(`git -C "${sibling}" add sibling2.txt && git -C "${sibling}" commit -q -m sibling2`);
    sh(`git -C "${sibling}" push -q origin main`);

    // Dirty the local tracked file (parent is STILL on main)
    writeFileSync(join(env.local, 'README.md'), 'modified by test\n');

    const r = runScript(env.local);
    // Exit 0 — gracefully skip (AISDLC-137 behavior; parent is on main so no refusal)
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /uncommitted tracked changes; skipping reset/);
    // File must NOT be reverted
    assert.equal(sh(`cat "${join(env.local, 'README.md')}"`), 'modified by test');
  });

  it('[AISDLC-358] parent on feature-branch, clean working tree → auto-checkout main + reset + log recovery', () => {
    // Create and check out a feature branch in the local repo.
    sh(`git -C "${env.local}" checkout -q -b feature/test-branch`);
    // Ensure we're on the feature branch
    assert.equal(sh(`git -C "${env.local}" symbolic-ref --short HEAD`), 'feature/test-branch');

    const r = runScript(env.local);
    // Must succeed (exit 0)
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // Must log the auto-recovery
    assert.match(r.stdout, /auto-recovered parent from 'feature\/test-branch' to main/);
    // Parent must now be on main
    assert.equal(sh(`git -C "${env.local}" symbolic-ref --short HEAD`), 'main');
  });

  it('[AISDLC-358] parent on feature-branch, dirty working tree → refuse + clear error', () => {
    // Create and check out a feature branch in the local repo.
    sh(`git -C "${env.local}" checkout -q -b feature/dirty-branch`);
    // Dirty a tracked file
    writeFileSync(join(env.local, 'README.md'), 'dirty feature branch content\n');

    const r = runScript(env.local);
    // Must fail (exit 1)
    assert.equal(r.status, 1, `expected exit 1; stdout: ${r.stdout}`);
    // Must print clear error naming the branch
    assert.match(r.stdout, /ERROR: parent working tree is on branch 'feature\/dirty-branch'/);
    // Must list dirty paths
    assert.match(r.stdout, /Dirty paths/);
    // Must print recovery command
    assert.match(r.stdout, /Recovery:/);
    assert.match(r.stdout, /checkout main/);
    // File must NOT have been reverted
    assert.equal(sh(`cat "${join(env.local, 'README.md')}"`), 'dirty feature branch content');
    // Branch must still be the feature branch (no auto-recovery attempted)
    assert.equal(sh(`git -C "${env.local}" symbolic-ref --short HEAD`), 'feature/dirty-branch');
  });

  // AISDLC-369: "behind on main with no local edits" — backlog task lifecycle files.
  it('[AISDLC-369] parent on main, only backlog task file dirty → proceeds with reset', () => {
    // Move origin/main forward so the script needs to sync.
    const sibling = join(env.root, 'sibling-backlog');
    sh(`git clone -q "${env.remote}" "${sibling}"`);
    sh(`git -C "${sibling}" config user.email s@s.s && git -C "${sibling}" config user.name s`);
    sh(`git -C "${sibling}" config commit.gpgsign false`);
    writeFileSync(join(sibling, 'sibling-backlog.txt'), 'sibling\n');
    sh(
      `git -C "${sibling}" add sibling-backlog.txt && git -C "${sibling}" commit -q -m sibling-backlog`,
    );
    sh(`git -C "${sibling}" push -q origin main`);

    // Dirty ONLY a backlog task file (simulate pipeline run that left a staged/modified task file)
    mkdirSync(join(env.local, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(
      join(env.local, 'backlog', 'tasks', 'aisdlc-test - test-task.md'),
      '---\nid: AISDLC-TEST\n---\n',
    );
    sh(`git -C "${env.local}" add backlog/tasks/`);

    // The working tree now has a staged backlog file — a tracked modification.
    const dirtyCheck = sh(
      `git -C "${env.local}" status --porcelain 2>/dev/null | grep -vE '^\\?\\?' | head -1 || true`,
    );
    assert.ok(dirtyCheck.length > 0, 'sanity: backlog task file should be staged/dirty');

    const r = runScript(env.local);
    // Must succeed (exit 0) — backlog task files are safe to reset
    assert.equal(r.status, 0, `expected exit 0; stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // Must log that it proceeded with reset (backlog task lifecycle recovery)
    assert.ok(
      r.stdout.includes('resetting parent working tree') ||
        r.stdout.includes('auto-recovering: dirty paths are backlog'),
      `expected reset or backlog-recovery log; stdout: ${r.stdout}`,
    );
  });

  it('[AISDLC-369] parent on main, mix of backlog + non-backlog dirty → skips reset', () => {
    // Move origin/main forward so the script needs to sync.
    const sibling = join(env.root, 'sibling-mix');
    sh(`git clone -q "${env.remote}" "${sibling}"`);
    sh(`git -C "${sibling}" config user.email s@s.s && git -C "${sibling}" config user.name s`);
    sh(`git -C "${sibling}" config commit.gpgsign false`);
    writeFileSync(join(sibling, 'sibling-mix.txt'), 'sibling\n');
    sh(`git -C "${sibling}" add sibling-mix.txt && git -C "${sibling}" commit -q -m sibling-mix`);
    sh(`git -C "${sibling}" push -q origin main`);

    // Dirty BOTH a backlog task file AND a non-backlog tracked file (README.md).
    mkdirSync(join(env.local, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(
      join(env.local, 'backlog', 'tasks', 'aisdlc-mix - test-task.md'),
      '---\nid: AISDLC-MIX\n---\n',
    );
    writeFileSync(join(env.local, 'README.md'), 'local edit to README\n');
    sh(`git -C "${env.local}" add backlog/tasks/`);
    // README.md is a tracked modification (not staged, just dirty working tree).

    const r = runScript(env.local);
    // Must exit 0 (graceful skip) — non-backlog dirty file blocks reset
    assert.equal(r.status, 0, `expected exit 0; stdout: ${r.stdout}`);
    // Must warn about uncommitted tracked changes, NOT proceed with reset
    assert.match(r.stdout, /uncommitted tracked changes; skipping reset/);
    // README.md must NOT be reverted
    assert.equal(sh(`cat "${join(env.local, 'README.md')}"`), 'local edit to README');
  });
});
