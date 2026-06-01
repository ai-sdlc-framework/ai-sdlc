/**
 * Regression tests for `scripts/check-backlog-drift-on-push.sh` — AISDLC-486.
 *
 * The motivating incident: PR #789 (AISDLC-474) renamed
 * `ai-sdlc-plugin/commands/review.md` → `review-pr.md`. A backlog task
 * (AISDLC-71) referenced the OLD path. After the rename, `backlog-drift check`
 * flagged the task as error-severity, blocking the PR until manually fixed.
 * The developer subagent did NOT search for or update inbound references.
 *
 * These tests prove the pre-push gate catches that class of issue BEFORE push,
 * so the CI Backlog Drift gate is satisfied locally not discovered in CI.
 *
 * ## Design
 * Like `check-backlog-drift.test.mjs`, we stub `npx` via a fake on PATH and
 * construct hermetic git repos in temp directories. The script's PRIMARY value
 * is the inbound-reference scan (Check 1) which runs BEFORE npx — so most
 * tests verify that scan path purely with git operations + grep, no npx stub
 * needed. Tests for Check 2 (task-level drift via npx backlog-drift) do
 * install a stub.
 *
 * Run with: node --test scripts/check-backlog-drift-on-push.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-backlog-drift-on-push.sh');

const ALL_ZEROS = '0000000000000000000000000000000000000000';

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf-8' });
}

/**
 * Build a stub npx shim. When backlog-drift is invoked, responds with
 * the caller-controlled JSON or exit code.
 *
 * @param {string} root  repo root
 * @param {object} opts
 * @param {string} [opts.jsonOutput='[]']  JSON to write to stdout on check --json
 * @param {number} [opts.exitCode=0]       exit code for check --json
 */
function installFakeNpx(root, { jsonOutput = '[]', exitCode = 0 } = {}) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(root, 'npx.log');
  // Escape the JSON for embedding in a shell heredoc
  const escapedJson = jsonOutput.replace(/'/g, "'\\''");
  const shim = `#!/usr/bin/env bash
echo "npx $*" >> "${logPath}"
# Only respond to backlog-drift check --json invocations
if printf '%s ' "$@" | grep -q 'backlog-drift'; then
  if printf '%s ' "$@" | grep -q -- '--json'; then
    printf '%s\\n' '${escapedJson}'
    exit ${exitCode}
  fi
fi
exit 0
`;
  const shimPath = join(binDir, 'npx');
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  return { binDir, logPath };
}

/**
 * Set up a hermetic git repo with initial baseline commit.
 * Returns the repo root path.
 */
function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-drift-push-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'Test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  // Create minimal directory structure
  mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(root, 'backlog', 'completed'), { recursive: true });
  writeFileSync(join(root, '.gitkeep'), '');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'baseline'], root);
  return root;
}

/**
 * Commit all staged changes with an auto-generated message.
 */
function commit(cwd, message = 'test commit') {
  git(['add', '-A'], cwd);
  git(['commit', '-q', '-m', message], cwd);
  return git(['rev-parse', 'HEAD'], cwd).trim();
}

/**
 * Run the check script with pre-push stdin protocol.
 *
 * @param {string} cwd        repo root to run the script in
 * @param {object} opts
 * @param {string} opts.localSha   SHA being pushed
 * @param {string} opts.remoteSha  SHA on remote (ALL_ZEROS for new branch)
 * @param {object} [opts.env={}]   extra env vars
 * @param {string} [opts.binDir='']  prepend dir (for fake npx)
 */
function runCheck(cwd, { localSha, remoteSha = ALL_ZEROS, env = {}, binDir = '' } = {}) {
  const pushInput = `refs/heads/test-branch ${localSha} refs/heads/test-branch ${remoteSha}\n`;
  const pathPrefix = binDir ? `${binDir}:` : '';
  return spawnSync('bash', [SCRIPT], {
    cwd,
    input: pushInput,
    env: cleanEnv({
      PATH: `${pathPrefix}${process.env.PATH}`,
      ...env,
    }),
    encoding: 'utf-8',
  });
}

describe('check-backlog-drift-on-push.sh (AISDLC-486)', () => {
  let root;

  beforeEach(() => {
    root = setupRepo();
    chmodSync(SCRIPT, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ── AC#3 CORE REGRESSION: rename orphans a backlog reference ──────

  it('AC#3: blocks push when a rename orphans a backlog task reference', () => {
    // Setup: create a source file that is referenced by a backlog task
    mkdirSync(join(root, 'ai-sdlc-plugin', 'commands'), { recursive: true });
    writeFileSync(join(root, 'ai-sdlc-plugin', 'commands', 'review.md'), '# Review command\n');
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-71 - replace-orchestrator.md'),
      '---\nid: AISDLC-71\nstatus: To Do\nreferences:\n  - ai-sdlc-plugin/commands/review.md\n---\n\nSee ai-sdlc-plugin/commands/review.md for the review command.\n',
    );
    const baseCommit = commit(root, 'add review.md and task reference');

    // Action: rename review.md → review-pr.md (as AISDLC-474 did)
    git(['mv', 'ai-sdlc-plugin/commands/review.md', 'ai-sdlc-plugin/commands/review-pr.md'], root);
    const renameCommit = commit(root, 'rename review.md to review-pr.md');

    installFakeNpx(root, { jsonOutput: '[]' });
    const { binDir } = (() => {
      const b = join(root, 'bin');
      return { binDir: b };
    })();

    const r = runCheck(root, {
      localSha: renameCommit,
      remoteSha: baseCommit,
      binDir,
    });

    // Should FAIL with clear message about the stale reference
    assert.equal(r.status, 1, `Expected exit 1 (blocked), got ${r.status}:\n${r.stderr}`);
    assert.match(r.stderr, /renames\/deletes files that are/);
    assert.match(r.stderr, /ai-sdlc-plugin\/commands\/review\.md/);
  });

  it('AC#3: blocks push when a file deletion orphans a backlog task reference', () => {
    // Create a referenced docs file
    mkdirSync(join(root, 'docs', 'ops'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ops', 'runbook.md'), '# Runbook\n');
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-100 - task-with-ref.md'),
      '---\nid: AISDLC-100\nstatus: To Do\nreferences:\n  - docs/ops/runbook.md\n---\n',
    );
    const baseCommit = commit(root, 'add docs and task');

    // Delete the referenced file
    git(['rm', 'docs/ops/runbook.md'], root);
    const deleteCommit = commit(root, 'delete runbook.md');

    const { binDir } = installFakeNpx(root, { jsonOutput: '[]' });
    const r = runCheck(root, { localSha: deleteCommit, remoteSha: baseCommit, binDir });

    assert.equal(r.status, 1, `Expected exit 1, got ${r.status}:\n${r.stderr}`);
    assert.match(r.stderr, /docs\/ops\/runbook\.md/);
  });

  it('AC#3: passes when rename updates the backlog reference in the same commit', () => {
    // The correct developer behavior: rename + update the reference atomically
    mkdirSync(join(root, 'ai-sdlc-plugin', 'commands'), { recursive: true });
    writeFileSync(join(root, 'ai-sdlc-plugin', 'commands', 'review.md'), '# Review\n');
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-71 - replace-orchestrator.md'),
      '---\nid: AISDLC-71\nstatus: To Do\nreferences:\n  - ai-sdlc-plugin/commands/review.md\n---\n',
    );
    const baseCommit = commit(root, 'add review.md and task');

    // Rename the file AND update the task reference in the same commit
    git(['mv', 'ai-sdlc-plugin/commands/review.md', 'ai-sdlc-plugin/commands/review-pr.md'], root);
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-71 - replace-orchestrator.md'),
      '---\nid: AISDLC-71\nstatus: To Do\nreferences:\n  - ai-sdlc-plugin/commands/review-pr.md\n---\n',
    );
    const fixedCommit = commit(root, 'rename review.md → review-pr.md, update backlog ref');

    const { binDir } = installFakeNpx(root, { jsonOutput: '[]' });
    const r = runCheck(root, { localSha: fixedCommit, remoteSha: baseCommit, binDir });

    assert.equal(r.status, 0, `Expected exit 0 (clean), got ${r.status}:\n${r.stderr}`);
  });

  // ── Escape hatches ────────────────────────────────────────────────

  it('AI_SDLC_BYPASS_ALL_GATES=1 skips the gate even when drift exists', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'old.ts'), 'export const x = 1;\n');
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-200 - ref-task.md'),
      '---\nid: AISDLC-200\nstatus: To Do\nreferences:\n  - src/old.ts\n---\n',
    );
    const baseCommit = commit(root, 'add src/old.ts and task');

    git(['rm', 'src/old.ts'], root);
    const deleteCommit = commit(root, 'delete src/old.ts');

    const { binDir } = installFakeNpx(root, { jsonOutput: '[]' });
    const r = runCheck(root, {
      localSha: deleteCommit,
      remoteSha: baseCommit,
      binDir,
      env: { AI_SDLC_BYPASS_ALL_GATES: '1' },
    });

    assert.equal(r.status, 0, `Expected bypass to succeed, got ${r.status}:\n${r.stderr}`);
    assert.match(r.stderr, /AI_SDLC_BYPASS_ALL_GATES=1/);
  });

  it('AI_SDLC_SKIP_BACKLOG_DRIFT_PUSH_GATE=1 skips the gate', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'old.ts'), 'export const x = 1;\n');
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-201 - ref-task.md'),
      '---\nid: AISDLC-201\nstatus: To Do\nreferences:\n  - src/old.ts\n---\n',
    );
    const baseCommit = commit(root, 'add src and task');

    git(['rm', 'src/old.ts'], root);
    const deleteCommit = commit(root, 'delete src/old.ts');

    const { binDir } = installFakeNpx(root, { jsonOutput: '[]' });
    const r = runCheck(root, {
      localSha: deleteCommit,
      remoteSha: baseCommit,
      binDir,
      env: { AI_SDLC_SKIP_BACKLOG_DRIFT_PUSH_GATE: '1' },
    });

    assert.equal(r.status, 0, `Expected skip to succeed, got ${r.status}:\n${r.stderr}`);
    assert.match(r.stderr, /AI_SDLC_SKIP_BACKLOG_DRIFT_PUSH_GATE=1/);
  });

  // ── Happy-path: no drift ──────────────────────────────────────────

  it('exits 0 when push has no renamed/deleted files', () => {
    // Just a new source file — no renames/deletes
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'new-feature.ts'), 'export const x = 1;\n');
    const baseCommit = git(['rev-parse', 'HEAD'], root).trim();
    const newCommit = commit(root, 'add new-feature.ts');

    const { binDir } = installFakeNpx(root, { jsonOutput: '[]' });
    const r = runCheck(root, { localSha: newCommit, remoteSha: baseCommit, binDir });

    assert.equal(r.status, 0, `Expected clean push to succeed, got ${r.status}:\n${r.stderr}`);
  });

  it('exits 0 for a rename with NO backlog references to the old path', () => {
    // Rename a file that no backlog task references — should be fine
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'util.ts'), 'export const util = {};\n');
    const baseCommit = commit(root, 'add src/util.ts');

    git(['mv', 'src/util.ts', 'src/utils.ts'], root);
    const renameCommit = commit(root, 'rename util.ts → utils.ts');

    const { binDir } = installFakeNpx(root, { jsonOutput: '[]' });
    const r = runCheck(root, { localSha: renameCommit, remoteSha: baseCommit, binDir });

    assert.equal(r.status, 0, `Expected clean rename to pass, got ${r.status}:\n${r.stderr}`);
  });

  it('exits 0 for a new-branch push (no remote SHA) with no drift', () => {
    // Simulate a fresh feature branch push (remote SHA = all zeros)
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'feature.ts'), 'export const feature = 1;\n');
    const newCommit = commit(root, 'add feature.ts');

    const { binDir } = installFakeNpx(root, { jsonOutput: '[]' });
    // ALL_ZEROS for remoteSha means new branch
    const r = runCheck(root, { localSha: newCommit, remoteSha: ALL_ZEROS, binDir });

    // No origin/main in the temp repo, so the script should gracefully skip
    assert.equal(r.status, 0, `Expected new-branch push to pass, got ${r.status}:\n${r.stderr}`);
  });

  // ── Check 2: task-level drift via npx shim ────────────────────────

  it('blocks push when backlog-drift reports error-severity in touched tasks', () => {
    // Add a task file that the stub will report as having errors
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-300 - broken-task.md'),
      '---\nid: AISDLC-300\nstatus: To Do\nreferences:\n  - nonexistent/file.md\n---\n',
    );
    const baseCommit = git(['rev-parse', 'HEAD'], root).trim();
    const newCommit = commit(root, 'add broken task');

    // Stub npx to return an error-severity JSON for this task
    const errorJson = JSON.stringify([
      {
        taskId: 'AISDLC-300',
        taskTitle: 'broken-task',
        type: 'ref-deleted',
        severity: 'error',
        message: 'Referenced file no longer exists: nonexistent/file.md',
        ref: 'nonexistent/file.md',
      },
    ]);
    const { binDir } = installFakeNpx(root, { jsonOutput: errorJson });

    const r = runCheck(root, { localSha: newCommit, remoteSha: baseCommit, binDir });

    assert.equal(r.status, 1, `Expected blocked push, got ${r.status}:\n${r.stderr}`);
    assert.match(r.stderr, /AISDLC-300/);
    assert.match(r.stderr, /error-severity drift/);
  });

  it('passes when backlog-drift reports only info/warning severity', () => {
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-301 - ok-task.md'),
      '---\nid: AISDLC-301\nstatus: To Do\n---\n',
    );
    const baseCommit = git(['rev-parse', 'HEAD'], root).trim();
    const newCommit = commit(root, 'add ok task');

    // Only warning/info — should not block
    const warnJson = JSON.stringify([
      {
        taskId: 'AISDLC-301',
        taskTitle: 'ok-task',
        type: 'dep-resolved',
        severity: 'info',
        message: 'Dependency AISDLC-299 has been completed',
        dependencyId: 'AISDLC-299',
      },
    ]);
    const { binDir } = installFakeNpx(root, { jsonOutput: warnJson });

    const r = runCheck(root, { localSha: newCommit, remoteSha: baseCommit, binDir });

    assert.equal(r.status, 0, `Expected clean push (warn only), got ${r.status}:\n${r.stderr}`);
  });
});
