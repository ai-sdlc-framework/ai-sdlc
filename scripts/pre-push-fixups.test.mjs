/**
 * Tests for `scripts/pre-push-fixups.sh` (AISDLC-386, AISDLC-1172).
 *
 * The orchestrator runs squash then task-move in one pass. RFC-0061 Phase 2 removed the
 * attestation signing and verifying sub-hook: the hook never signs, never verifies, and a push
 * is refused for git reasons and mechanical task-move fixups only.
 *
 * Run with: node --test scripts/pre-push-fixups.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  chmodSync,
  readFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_SCRIPT = join(__dirname, 'pre-push-fixups.sh');
const PROJECT_ROOT = join(__dirname, '..');

// ── helpers ──────────────────────────────────────────────────────────────────

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // Never leak host git index into the hermetic test repo.
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  // Don't inherit any bypass/skip from the host operator shell.
  delete env.AI_SDLC_BYPASS_ALL_GATES;
  delete env.AI_SDLC_INTERNAL_NO_EXIT_1;
  delete env.AI_SDLC_SKIP_TASK_MOVE;
  delete env.AI_SDLC_TASK_COMPLETE_CMD;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf-8' });
}

/**
 * Set up a minimal git repo with all the directory structures that the two
 * sub-hooks expect.
 */
function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-fixups-orch-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);

  // Directory structure for task-move.
  mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(root, 'backlog', 'completed'), { recursive: true });

  // Directory structure for attestation-sign.
  mkdirSync(join(root, '.ai-sdlc', 'verdicts'), { recursive: true });
  mkdirSync(join(root, '.ai-sdlc', 'attestations'), { recursive: true });

  // Baseline commit.
  writeFileSync(join(root, 'README.md'), 'baseline\n');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'baseline'], root);
  // Set up origin/main ref.
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], root);
  return root;
}

/** Write a minimal task file in backlog/tasks/ for the given task ID. */
function writeTaskFile(root, taskId) {
  const taskIdLower = taskId.toLowerCase();
  const filename = `${taskIdLower} - Test Task for ${taskId}.md`;
  const path = join(root, 'backlog', 'tasks', filename);
  writeFileSync(
    path,
    `---\nid: ${taskId}\ntitle: Test Task for ${taskId}\nstatus: In Progress\n---\n\n## Description\n\nTest task.\n`,
  );
  return filename;
}

/**
 * Install a fake cli-task-complete stub that does a git mv.
 * Returns the cmd string for AI_SDLC_TASK_COMPLETE_CMD.
 */
function installFakeTaskCli(root) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const shimPath = join(binDir, 'fake-cli-task.sh');
  const shim = `#!/usr/bin/env bash
WT_ROOT=$(git rev-parse --show-toplevel)
TASK_ID_LOWER=$(echo "$1" | tr '[:upper:]' '[:lower:]')
shopt -s nullglob
TASK_FILES=("$WT_ROOT/backlog/tasks/$TASK_ID_LOWER - "*.md)
if [ "\${#TASK_FILES[@]}" -gt 0 ]; then
  for TASK_FILE in "\${TASK_FILES[@]}"; do
    BASENAME=$(basename "$TASK_FILE")
    git -C "$WT_ROOT" mv "backlog/tasks/$BASENAME" "backlog/completed/$BASENAME"
  done
fi
exit 0
`;
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  return `bash ${shimPath}`;
}

/**
 * Run the orchestrator script with push stdin forwarded.
 */
function runOrchestrator(cwd, { localSha, remoteSha, env = {} } = {}) {
  const NULL_SHA = '0000000000000000000000000000000000000000';
  const resolvedLocalSha =
    localSha ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' }).trim();
  const resolvedRemoteSha = remoteSha ?? NULL_SHA;
  const stdinData = `refs/heads/main ${resolvedLocalSha} refs/remotes/origin/main ${resolvedRemoteSha}\n`;

  return spawnSync('bash', [ORCHESTRATOR_SCRIPT], {
    cwd,
    env: cleanEnv(env),
    input: stdinData,
    encoding: 'utf-8',
  });
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('pre-push-fixups.sh (AISDLC-386)', () => {
  let root;

  beforeEach(() => {
    root = setupRepo();
    chmodSync(ORCHESTRATOR_SCRIPT, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ── (bypass) Master bypass env var ──────────────────────────────────────

  it('AI_SDLC_BYPASS_ALL_GATES=1 exits 0 immediately — no sub-hook runs', () => {
    writeTaskFile(root, 'AISDLC-999');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: add feature (AISDLC-999)'], root);
    const headBefore = git(['rev-parse', 'HEAD'], root).trim();

    const taskCmd = installFakeTaskCli(root);
    const r = runOrchestrator(root, {
      env: { AI_SDLC_TASK_COMPLETE_CMD: taskCmd, AI_SDLC_BYPASS_ALL_GATES: '1' },
    });

    assert.equal(r.status, 0, `expected 0 with bypass, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /AI_SDLC_BYPASS_ALL_GATES=1/);
    // HEAD must not change.
    const headAfter = git(['rev-parse', 'HEAD'], root).trim();
    assert.equal(headAfter, headBefore, 'HEAD must not change with bypass');
  });

  // ── Combination 1: no fixups needed (0/0) ──────────────────────────────

  it('(combo 00) exits 0 silently when no fixup is needed', () => {
    // No task ID in commit subject, no active-task sentinel.
    writeFileSync(join(root, 'some-file.txt'), 'content\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: feature without any fixup triggers'], root);
    const headBefore = git(['rev-parse', 'HEAD'], root).trim();

    const taskCmd = installFakeTaskCli(root);
    const r = runOrchestrator(root, {
      env: { AI_SDLC_TASK_COMPLETE_CMD: taskCmd },
    });

    assert.equal(r.status, 0, `expected 0 (no fixups), got ${r.status}: ${r.stderr}`);
    // No new commit must land.
    const headAfter = git(['rev-parse', 'HEAD'], root).trim();
    assert.equal(headAfter, headBefore, 'HEAD must not change when no fixup needed');
  });

  // ── Combination 2: task-move only (1/0) ────────────────────────────────

  it('(combo 10) exits 1 when only task-move runs', () => {
    writeTaskFile(root, 'AISDLC-100');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: task-move-only case (AISDLC-100)'], root);
    const headBefore = git(['rev-parse', 'HEAD'], root).trim();

    const taskCmd = installFakeTaskCli(root);
    const r = runOrchestrator(root, {
      env: { AI_SDLC_TASK_COMPLETE_CMD: taskCmd },
    });

    assert.equal(r.status, 1, `expected 1 (task-move ran), got ${r.status}: ${r.stderr}`);
    // Consolidated message must list task-move.
    assert.match(r.stderr, /Auto-fixed:.*task-move/i);
    assert.match(r.stderr, /Re-run `git push`/i);

    // HEAD must have changed (chore commit added by task-move sub-hook).
    const headAfter = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(headAfter, headBefore, 'task-move must add a chore commit');

    // Task file must be in completed/.
    assert.equal(
      existsSync(join(root, 'backlog', 'completed', 'aisdlc-100 - Test Task for AISDLC-100.md')),
      true,
      'task file must be in backlog/completed/',
    );
  });

  it('never signs or verifies: a push with verdict files and code changes exits 0 with no new commit', () => {
    mkdirSync(join(root, '.ai-sdlc', 'verdicts'), { recursive: true });
    writeFileSync(join(root, '.active-task'), 'AISDLC-902');
    writeFileSync(join(root, '.ai-sdlc', 'verdicts', 'aisdlc-902.json'), '[]');
    writeFileSync(join(root, 'some-code.ts'), 'export const y = 2;\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: code change (AISDLC-902)'], root);
    const headBefore = git(['rev-parse', 'HEAD'], root).trim();
    const r = runOrchestrator(root, {});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(['rev-parse', 'HEAD'], root).trim(), headBefore);
    assert.doesNotMatch(r.stderr, /attestation-sign/);
    assert.equal(existsSync(join(PROJECT_ROOT, 'scripts', 'check-attestation-sign.sh')), false);
    assert.equal(
      existsSync(join(PROJECT_ROOT, 'ai-sdlc-plugin', 'scripts', 'check-attestation-sign.sh')),
      false,
    );
  });

  it('the second push after the task-move fixup exits 0 and adds no commit', () => {
    writeTaskFile(root, 'AISDLC-101');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: idempotence (AISDLC-101)'], root);
    const env = { AI_SDLC_TASK_COMPLETE_CMD: installFakeTaskCli(root) };
    assert.equal(runOrchestrator(root, { env }).status, 1);
    const head = git(['rev-parse', 'HEAD'], root).trim();
    assert.equal(runOrchestrator(root, { env }).status, 0);
    assert.equal(git(['rev-parse', 'HEAD'], root).trim(), head);
  });

  // ── AISDLC-837: single orchestrator owns squash and task-move ──

  it('.husky/pre-push calls only the orchestrator, never the sub-hooks directly', () => {
    const hook = readFileSync(join(PROJECT_ROOT, '.husky', 'pre-push'), 'utf-8');
    const code = hook
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    assert.equal((code.match(/pre-push-fixups\.sh/g) ?? []).length, 1);
    assert.doesNotMatch(code, /check-task-moved\.sh/);
    assert.doesNotMatch(code, /check-attestation-sign\.sh/);
    assert.doesNotMatch(code, /squash-attestation-chores\.sh/);
  });

  // ── AC-5: sub-hooks retain standalone exit-1 behavior ─────────────────

  it('check-task-moved.sh still exits 1 when invoked directly (no AI_SDLC_INTERNAL_NO_EXIT_1)', () => {
    const taskMovedScript = join(PROJECT_ROOT, 'scripts', 'check-task-moved.sh');
    writeTaskFile(root, 'AISDLC-901');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: standalone test (AISDLC-901)'], root);

    const taskCmd = installFakeTaskCli(root);
    const NULL_SHA = '0000000000000000000000000000000000000000';
    const localSha = git(['rev-parse', 'HEAD'], root).trim();
    const stdinData = `refs/heads/main ${localSha} refs/remotes/origin/main ${NULL_SHA}\n`;

    const r = spawnSync('bash', [taskMovedScript], {
      cwd: root,
      env: cleanEnv({ AI_SDLC_TASK_COMPLETE_CMD: taskCmd }),
      input: stdinData,
      encoding: 'utf-8',
    });

    assert.equal(
      r.status,
      1,
      `standalone check-task-moved.sh must exit 1 (not in orchestrator mode), got ${r.status}: ${r.stderr}`,
    );
  });
});
