/**
 * Tests for `scripts/check-task-moved.sh` — AISDLC-220.
 *
 * The script is invoked from `.husky/pre-push` AFTER the coverage gate and
 * BEFORE the attestation-sign gate. It auto-moves a backlog task file from
 * `backlog/tasks/` to `backlog/completed/` when any commit in the push range
 * has a subject containing `(AISDLC-N)` and the task file is still in tasks/.
 *
 * The cli-task-complete command is overridable via AI_SDLC_TASK_COMPLETE_CMD
 * so we stub it with a tiny shell script that just `git mv`s the fixture file.
 * This keeps the tests hermetic — no pipeline-cli build required.
 *
 * Run with: node --test scripts/check-task-moved.test.mjs
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
const SCRIPT = join(__dirname, 'check-task-moved.sh');

/** Project root (for reading .husky/pre-push in the order assertion test). */
const PROJECT_ROOT = join(__dirname, '..');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  // Don't inherit stale overrides from the host env.
  delete env.AI_SDLC_BYPASS_ALL_GATES;
  delete env.AI_SDLC_SKIP_TASK_MOVE;
  delete env.AI_SDLC_TASK_COMPLETE_CMD;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf-8' });
}

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-task-move-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  // Create backlog directory structure.
  mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(root, 'backlog', 'completed'), { recursive: true });
  // Baseline commit so HEAD exists.
  writeFileSync(join(root, 'README.md'), 'baseline\n');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'baseline'], root);
  // Set up origin/main ref so the hook can compute merge-base.
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], root);
  return root;
}

/**
 * Write a minimal task file in backlog/tasks/ for the given task ID.
 * Returns the filename (without the root path prefix).
 */
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
 * Install a fake cli-task-complete stub at `<root>/bin/fake-cli-task-complete.sh`
 * that simply `git mv`s the task file from tasks/ to completed/.
 * Returns a command string suitable for AI_SDLC_TASK_COMPLETE_CMD.
 *
 * @param {string} root  worktree root
 * @param {object} opts
 * @param {boolean} [opts.fail=false]    exits non-zero without moving (simulates build missing)
 * @param {boolean} [opts.silent=false]  exits 0 but does NOT move the file
 */
function installFakeCli(root, { fail = false, silent = false } = {}) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(root, 'cli.log');
  const shimPath = join(binDir, 'fake-cli.sh');

  const failBlock = fail ? 'exit 7' : '';
  const moveBlock = silent
    ? '# silent mode: do not move the file'
    : `# Move the task file from tasks/ to completed/
WT_ROOT=$(git rev-parse --show-toplevel)
TASK_ID_LOWER=$(echo "$1" | tr '[:upper:]' '[:lower:]')
# Find the task file (glob match).
shopt -s nullglob
TASK_FILES=("$WT_ROOT/backlog/tasks/$TASK_ID_LOWER - "*.md)
if [ "\${#TASK_FILES[@]}" -gt 0 ]; then
  for TASK_FILE in "\${TASK_FILES[@]}"; do
    BASENAME=$(basename "$TASK_FILE")
    git -C "$WT_ROOT" mv "backlog/tasks/$BASENAME" "backlog/completed/$BASENAME"
  done
fi`;

  const shim = `#!/usr/bin/env bash
echo "fake-cli $*" >> "${logPath}"
${failBlock}
${moveBlock}
exit 0
`;
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  return { cmd: `bash ${shimPath}`, logPath };
}

/**
 * Run the hook script. Provides stdin with push info as husky would.
 * @param {string} cwd  working directory (worktree root)
 * @param {object} opts
 * @param {string} [opts.localSha]   SHA of local HEAD (default: current HEAD)
 * @param {string} [opts.remoteSha]  SHA of remote HEAD (default: null = new branch)
 * @param {object} [opts.env]        extra env vars
 */
function runHook(cwd, { localSha, remoteSha, env = {} } = {}) {
  const NULL_SHA = '0000000000000000000000000000000000000000';
  const resolvedLocalSha =
    localSha ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' }).trim();
  const resolvedRemoteSha = remoteSha ?? NULL_SHA;
  const stdinData = `refs/heads/main ${resolvedLocalSha} refs/remotes/origin/main ${resolvedRemoteSha}\n`;

  return spawnSync('bash', [SCRIPT], {
    cwd,
    env: cleanEnv(env),
    input: stdinData,
    encoding: 'utf-8',
  });
}

describe('check-task-moved.sh (AISDLC-220)', () => {
  let root;

  beforeEach(() => {
    root = setupRepo();
    chmodSync(SCRIPT, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ── (a) Main happy path ──────────────────────────────────────────────

  it('(a) moves task file + creates chore commit + exits 1 when commit subject has (AISDLC-N)', () => {
    // Set up task file in tasks/.
    const filename = writeTaskFile(root, 'AISDLC-999');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: add feature (AISDLC-999)'], root);

    const { cmd } = installFakeCli(root);
    const r = runHook(root, { env: { AI_SDLC_TASK_COMPLETE_CMD: cmd } });

    assert.equal(r.status, 1, `expected 1 (re-push required), got ${r.status}: ${r.stderr}`);
    // Re-push message must be actionable.
    assert.match(r.stderr, /re-run `git push`|re-push required|moved.*to backlog\/completed/i);

    // Task file must exist in completed/ and NOT in tasks/.
    assert.equal(
      existsSync(join(root, 'backlog', 'completed', filename)),
      true,
      'task file must be in backlog/completed/ after move',
    );
    assert.equal(
      existsSync(join(root, 'backlog', 'tasks', filename)),
      false,
      'task file must be removed from backlog/tasks/ after move',
    );

    // A new commit must have landed on top.
    const newSubject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.match(newSubject, /chore: auto-close AISDLC-999/i);
  });

  // ── (bypass) Master bypass env var ──────────────────────────────────

  it('AI_SDLC_BYPASS_ALL_GATES=1 exits 0 immediately without moving any file', () => {
    writeTaskFile(root, 'AISDLC-999');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: add feature (AISDLC-999)'], root);
    const headBefore = git(['rev-parse', 'HEAD'], root).trim();

    const { cmd, logPath } = installFakeCli(root);
    const r = runHook(root, {
      env: { AI_SDLC_TASK_COMPLETE_CMD: cmd, AI_SDLC_BYPASS_ALL_GATES: '1' },
    });

    assert.equal(r.status, 0, `expected exit 0 with bypass, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /AI_SDLC_BYPASS_ALL_GATES=1/);
    // CLI must NOT be invoked.
    assert.equal(existsSync(logPath), false, 'CLI must NOT run when bypass is set');
    // HEAD must not change.
    const headAfter = git(['rev-parse', 'HEAD'], root).trim();
    assert.equal(headAfter, headBefore, 'HEAD must not change when bypass is set');
  });

  it('AI_SDLC_BYPASS_ALL_GATES=0 does NOT bypass (falls through to normal logic)', () => {
    // When the var is explicitly 0, the bypass block must NOT fire.
    writeTaskFile(root, 'AISDLC-888');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: feature (AISDLC-888)'], root);

    const { cmd } = installFakeCli(root);
    const r = runHook(root, {
      env: { AI_SDLC_TASK_COMPLETE_CMD: cmd, AI_SDLC_BYPASS_ALL_GATES: '0' },
    });

    // Normal logic runs: task is moved → exits 1.
    assert.equal(
      r.status,
      1,
      `expected 1 (normal run) when bypass=0, got ${r.status}: ${r.stderr}`,
    );
    assert.doesNotMatch(r.stderr, /AI_SDLC_BYPASS_ALL_GATES=1/);
  });

  // ── (b) Skip env ─────────────────────────────────────────────────────

  it('(b) AI_SDLC_SKIP_TASK_MOVE=1 short-circuits with exit 0 even when move is needed', () => {
    writeTaskFile(root, 'AISDLC-999');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: add feature (AISDLC-999)'], root);
    const headBefore = git(['rev-parse', 'HEAD'], root).trim();

    const { cmd, logPath } = installFakeCli(root);
    const r = runHook(root, {
      env: {
        AI_SDLC_TASK_COMPLETE_CMD: cmd,
        AI_SDLC_SKIP_TASK_MOVE: '1',
      },
    });

    assert.equal(r.status, 0, `expected 0 with deferral, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /AI_SDLC_SKIP_TASK_MOVE=1/);
    // CLI must NOT be invoked.
    assert.equal(existsSync(logPath), false, 'CLI must NOT run under deferral');
    // No new commit must land.
    const headAfter = git(['rev-parse', 'HEAD'], root).trim();
    assert.equal(headAfter, headBefore, 'HEAD must not change with deferral');
  });

  // ── (c) Idempotent second push ────────────────────────────────────────

  it('(c) idempotent — second push exits 0 after chore commit is on HEAD', () => {
    // First push cycle: hook moves file + creates chore commit.
    writeTaskFile(root, 'AISDLC-999');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: add feature (AISDLC-999)'], root);
    const devHead = git(['rev-parse', 'HEAD'], root).trim();

    const { cmd } = installFakeCli(root);
    const r1 = runHook(root, { env: { AI_SDLC_TASK_COMPLETE_CMD: cmd } });
    assert.equal(r1.status, 1, `first push: expected 1, got ${r1.status}: ${r1.stderr}`);

    const choreHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(choreHead, devHead, 'first push must add a chore commit');

    // Second push: HEAD is the chore commit. Hook must exit 0 without
    // making another commit.
    const commitCountBefore = git(['rev-list', '--count', 'HEAD'], root).trim();
    const r2 = runHook(root, { env: { AI_SDLC_TASK_COMPLETE_CMD: cmd } });
    assert.equal(
      r2.status,
      0,
      `second push (HEAD is chore commit) must be a no-op; got ${r2.status}: ${r2.stderr}`,
    );

    const commitCountAfter = git(['rev-list', '--count', 'HEAD'], root).trim();
    assert.equal(
      commitCountAfter,
      commitCountBefore,
      `second push must NOT add another chore commit (${commitCountBefore} -> ${commitCountAfter})`,
    );
  });

  // ── (d) No match in commit subject ───────────────────────────────────

  it('(d) exits 0 when commit subject does NOT contain (AISDLC-N)', () => {
    writeTaskFile(root, 'AISDLC-999');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: add feature without task ref'], root);
    const headBefore = git(['rev-parse', 'HEAD'], root).trim();

    const { cmd, logPath } = installFakeCli(root);
    const r = runHook(root, { env: { AI_SDLC_TASK_COMPLETE_CMD: cmd } });

    assert.equal(r.status, 0, `expected 0 (no task ID in subject), got ${r.status}: ${r.stderr}`);
    assert.equal(existsSync(logPath), false, 'CLI must NOT run when no task ID in subject');
    const headAfter = git(['rev-parse', 'HEAD'], root).trim();
    assert.equal(headAfter, headBefore, 'HEAD must not change when no task ID matched');
  });

  // ── (e) Multiple task IDs in push range ──────────────────────────────

  it('(e) multiple task IDs in push range → single chore commit with all moves', () => {
    // Commit 1: references AISDLC-901.
    writeTaskFile(root, 'AISDLC-901');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: first feature (AISDLC-901)'], root);

    // Commit 2: references AISDLC-902.
    writeTaskFile(root, 'AISDLC-902');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: second feature (AISDLC-902)'], root);

    const { cmd } = installFakeCli(root);
    const r = runHook(root, { env: { AI_SDLC_TASK_COMPLETE_CMD: cmd } });

    assert.equal(r.status, 1, `expected 1 (chore commit), got ${r.status}: ${r.stderr}`);

    // Both files must exist in completed/.
    const filename1 = 'aisdlc-901 - Test Task for AISDLC-901.md';
    const filename2 = 'aisdlc-902 - Test Task for AISDLC-902.md';
    assert.equal(
      existsSync(join(root, 'backlog', 'completed', filename1)),
      true,
      'AISDLC-901 must be in completed/',
    );
    assert.equal(
      existsSync(join(root, 'backlog', 'completed', filename2)),
      true,
      'AISDLC-902 must be in completed/',
    );

    // Single chore commit (not two separate ones).
    const newSubject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.match(newSubject, /AISDLC-901/i, 'chore subject must reference AISDLC-901');
    assert.match(newSubject, /AISDLC-902/i, 'chore subject must reference AISDLC-902');
    assert.match(newSubject, /^chore: auto-close /, 'must start with chore: auto-close');
  });

  // ── (h) cli-task-complete failure path (AISDLC-220 robustness) ───────

  it('(h) exits 2 with clear ERROR message when cli-task-complete fails', () => {
    writeTaskFile(root, 'AISDLC-700');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: failing case (AISDLC-700)'], root);

    const { cmd } = installFakeCli(root, { fail: true });
    const r = runHook(root, { env: { AI_SDLC_TASK_COMPLETE_CMD: cmd } });

    assert.equal(r.status, 2, `expected 2 (cli failure), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /ERROR: cli-task-complete .*failed/i);
  });

  it('(i) exits 2 when cli-task-complete returns success but does not move the file', () => {
    writeTaskFile(root, 'AISDLC-701');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: silent-noop case (AISDLC-701)'], root);

    const { cmd } = installFakeCli(root, { silent: true });
    const r = runHook(root, { env: { AI_SDLC_TASK_COMPLETE_CMD: cmd } });

    assert.equal(
      r.status,
      2,
      `expected 2 (post-move integrity check), got ${r.status}: ${r.stderr}`,
    );
    assert.match(r.stderr, /did not produce backlog\/completed/i);
  });

  // ── (f) Task already in completed/ ───────────────────────────────────

  it('(f) exits 0 when task is already in backlog/completed/', () => {
    // Put the file directly in completed/ (already moved).
    const taskIdLower = 'aisdlc-999';
    const filename = `${taskIdLower} - Test Task for AISDLC-999.md`;
    writeFileSync(
      join(root, 'backlog', 'completed', filename),
      '---\nid: AISDLC-999\nstatus: Done\n---\n',
    );
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: add feature (AISDLC-999)'], root);
    const headBefore = git(['rev-parse', 'HEAD'], root).trim();

    const { cmd, logPath } = installFakeCli(root);
    const r = runHook(root, { env: { AI_SDLC_TASK_COMPLETE_CMD: cmd } });

    assert.equal(r.status, 0, `expected 0 (already in completed/), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /already in backlog\/completed\//i);
    assert.equal(existsSync(logPath), false, 'CLI must NOT run when task is already in completed/');
    const headAfter = git(['rev-parse', 'HEAD'], root).trim();
    assert.equal(headAfter, headBefore, 'HEAD must not change when task already in completed/');
  });

  // ── (g) Load-bearing order assertion (AC #2) ─────────────────────────

  it('(g) .husky/pre-push invokes check-task-moved.sh AFTER check-coverage.sh and BEFORE check-attestation-sign.sh', () => {
    // Read the actual .husky/pre-push file from the project root.
    const prePushPath = join(PROJECT_ROOT, '.husky', 'pre-push');
    assert.equal(existsSync(prePushPath), true, `.husky/pre-push must exist at ${prePushPath}`);

    const content = readFileSync(prePushPath, 'utf-8');
    const lines = content.split('\n');

    // Find the line indices for each script invocation (search for the script name).
    const coverageIdx = lines.findIndex((l) => l.includes('check-coverage.sh'));
    const taskMoveIdx = lines.findIndex((l) => l.includes('check-task-moved.sh'));
    const attestationIdx = lines.findIndex((l) => l.includes('check-attestation-sign.sh'));

    assert.ok(
      coverageIdx !== -1,
      `check-coverage.sh must be present in .husky/pre-push:\n${content}`,
    );
    assert.ok(
      taskMoveIdx !== -1,
      `check-task-moved.sh must be present in .husky/pre-push:\n${content}`,
    );
    assert.ok(
      attestationIdx !== -1,
      `check-attestation-sign.sh must be present in .husky/pre-push:\n${content}`,
    );

    assert.ok(
      coverageIdx < taskMoveIdx,
      `check-coverage.sh (line ${coverageIdx + 1}) must appear BEFORE check-task-moved.sh (line ${taskMoveIdx + 1})`,
    );
    assert.ok(
      taskMoveIdx < attestationIdx,
      `check-task-moved.sh (line ${taskMoveIdx + 1}) must appear BEFORE check-attestation-sign.sh (line ${attestationIdx + 1}) — order is load-bearing (AC #2: contentHashV4 binds {path, headBlobSha}; move must happen before sign)`,
    );
  });

  // ── Extra: chore commit must not carry CI-skip tokens (AISDLC-88) ────

  it('the chore commit body does NOT contain a CI-skip magic token (AISDLC-88 contract)', () => {
    writeTaskFile(root, 'AISDLC-999');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: add feature (AISDLC-999)'], root);

    const { cmd } = installFakeCli(root);
    const r = runHook(root, { env: { AI_SDLC_TASK_COMPLETE_CMD: cmd } });
    assert.equal(r.status, 1);

    const body = git(['log', '-1', '--format=%B', 'HEAD'], root);
    for (const tok of ['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]']) {
      assert.equal(
        body.toLowerCase().includes(tok.toLowerCase()),
        false,
        `chore commit body must not contain "${tok}": ${body}`,
      );
    }
  });

  // ── Extra: skip env message is actionable ─────────────────────────────

  it('re-push hint mentions the AI_SDLC_SKIP_TASK_MOVE=1 escape hatch', () => {
    writeTaskFile(root, 'AISDLC-999');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: add feature (AISDLC-999)'], root);

    const { cmd } = installFakeCli(root);
    const r = runHook(root, { env: { AI_SDLC_TASK_COMPLETE_CMD: cmd } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /AI_SDLC_SKIP_TASK_MOVE=1/);
  });
});
