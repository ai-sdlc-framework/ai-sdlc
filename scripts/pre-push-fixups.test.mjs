/**
 * Tests for `scripts/pre-push-fixups.sh` — AISDLC-386.
 *
 * The orchestrator runs task-move → attestation-sign in one pass.
 * (mcp-bundle-sync was removed by AISDLC-385 — bundle now distributed via npm.)
 * Each sub-hook is invoked with AI_SDLC_INTERNAL_NO_EXIT_1=1 so it does its
 * work but exits 0. The orchestrator exits 1 ONCE if any fixup ran, or exits 0
 * silently if nothing was needed.
 *
 * Tests cover all 4 combinations of (task-move needed × attestation-sign needed)
 * to verify the orchestrator exits 1 when ≥1 fixup ran and exits 0 when no
 * fixup was needed.
 *
 * Sub-hooks are stubbed via:
 *   AI_SDLC_TASK_COMPLETE_CMD   — stubs cli-task-complete in check-task-moved.sh
 *   AI_SDLC_SIGN_ATTESTATION_CMD— stubs sign-attestation.mjs in check-attestation-sign.sh
 *
 * Ordering invariant: task-move MUST run before attestation-sign (contentHashV4
 * load-bearing constraint). Tested via commit-subject ordering assertion.
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
  delete env.AI_SDLC_SKIP_ATTESTATION_SIGN;
  delete env.AI_SDLC_TASK_COMPLETE_CMD;
  delete env.AI_SDLC_SIGN_ATTESTATION_CMD;
  // attestation-sign needs schema version env clean.
  delete env.AI_SDLC_SCHEMA_VERSION;
  delete env.AI_SDLC_V6_CUTOVER_ACTIVE;
  // Sub-attestation stub (needed by check-attestation-sign.sh in test mode).
  delete env.AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD;
  delete env.AI_SDLC_TEST_MODE;
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
 * Install a fake sign-attestation stub. Writes the expected envelope file.
 * When attestSign is true and a verdict file exists, it writes the envelope.
 */
function installFakeSignAttestation(root) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const shimPath = join(binDir, 'fake-sign.sh');
  const shim = `#!/usr/bin/env bash
# Parse --review-verdicts and --schema-version args to find verdict file.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --review-verdicts) VERDICT_FILE="$2"; shift 2 ;;
    --schema-version) SCHEMA="$2"; shift 2 ;;
    *) shift ;;
  esac
done
WT_ROOT=$(git rev-parse --show-toplevel)
HEAD_SHA=$(git rev-parse HEAD)
if [ "\${SCHEMA:-v5}" = "v6" ]; then
  ATT_FILE="$WT_ROOT/.ai-sdlc/attestations/$HEAD_SHA.v6.dsse.json"
else
  ATT_FILE="$WT_ROOT/.ai-sdlc/attestations/$HEAD_SHA.dsse.json"
fi
echo '{"fake":"attestation"}' > "$ATT_FILE"
exit 0
`;
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  return `bash ${shimPath}`;
}

/**
 * Write a verdict file + active-task sentinel so attestation-sign fires.
 */
function setupAttestationConditions(root, taskId) {
  const taskIdLower = taskId.toLowerCase();
  writeFileSync(join(root, '.active-task'), taskId);
  writeFileSync(
    join(root, '.ai-sdlc', 'verdicts', `${taskIdLower}.json`),
    JSON.stringify([
      {
        agentId: 'code-reviewer',
        harness: 'test',
        approved: true,
        findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        summary: 'Test approval',
      },
    ]),
  );
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

  // ── Combination 3: attestation-sign only (0/1) ─────────────────────────

  it('(combo 01) exits 1 when only attestation-sign runs', () => {
    const TASK_ID = 'AISDLC-200';
    setupAttestationConditions(root, TASK_ID);

    writeFileSync(join(root, 'some-code.ts'), 'export const x = 1;\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', `feat: code change (${TASK_ID})`], root);
    // Move task file to completed (so task-move doesn't fire) and commit.
    const taskIdLower = TASK_ID.toLowerCase();
    const taskFilename = `${taskIdLower} - Test Task for ${TASK_ID}.md`;
    writeFileSync(
      join(root, 'backlog', 'completed', taskFilename),
      `---\nid: ${TASK_ID}\nstatus: Done\n---\n`,
    );
    git(['add', '.'], root);
    git(['commit', '-q', '-m', `chore: task already moved (${TASK_ID})`], root);

    const signCmd = installFakeSignAttestation(root);
    const r = runOrchestrator(root, {
      env: {
        AI_SDLC_SIGN_ATTESTATION_CMD: signCmd,
        // Enable attestation-sign test mode (AISDLC-380 sub-attestation gate bypass).
        AI_SDLC_TEST_MODE: '1',
        AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD: 'true',
        AI_SDLC_V6_CUTOVER_ACTIVE: '1',
        AI_SDLC_SCHEMA_VERSION: 'v5',
      },
    });

    assert.equal(r.status, 1, `expected 1 (attestation-sign ran), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Auto-fixed:.*attestation-sign/i);
    assert.match(r.stderr, /Re-run `git push`/i);
  });

  // ── Combination 4: task-move + attestation-sign (1/1) ──────────────────

  it('(combo 11) exits 1 and lists both when task-move + attestation-sign both run', () => {
    const TASK_ID = 'AISDLC-300';
    setupAttestationConditions(root, TASK_ID);

    writeTaskFile(root, TASK_ID);
    git(['add', '.'], root);
    git(['commit', '-q', '-m', `feat: dual fixup case (${TASK_ID})`], root);

    const taskCmd = installFakeTaskCli(root);
    const signCmd = installFakeSignAttestation(root);
    const r = runOrchestrator(root, {
      env: {
        AI_SDLC_TASK_COMPLETE_CMD: taskCmd,
        AI_SDLC_SIGN_ATTESTATION_CMD: signCmd,
        AI_SDLC_TEST_MODE: '1',
        AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD: 'true',
        AI_SDLC_V6_CUTOVER_ACTIVE: '1',
        AI_SDLC_SCHEMA_VERSION: 'v5',
      },
    });

    assert.equal(r.status, 1, `expected 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Auto-fixed:/i);
    assert.match(r.stderr, /task-move/i);
    assert.match(r.stderr, /attestation-sign/i);
    assert.match(r.stderr, /Re-run `git push`/i);
  });

  // ── Ordering invariant ────────────────────────────────────────────────────

  it('task-move commit appears BEFORE attestation-sign commit in git log', () => {
    const TASK_ID = 'AISDLC-700';
    setupAttestationConditions(root, TASK_ID);

    writeTaskFile(root, TASK_ID);
    git(['add', '.'], root);
    git(['commit', '-q', '-m', `feat: ordering test (${TASK_ID})`], root);

    const taskCmd = installFakeTaskCli(root);
    const signCmd = installFakeSignAttestation(root);
    const r = runOrchestrator(root, {
      env: {
        AI_SDLC_TASK_COMPLETE_CMD: taskCmd,
        AI_SDLC_SIGN_ATTESTATION_CMD: signCmd,
        AI_SDLC_TEST_MODE: '1',
        AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD: 'true',
        AI_SDLC_V6_CUTOVER_ACTIVE: '1',
        AI_SDLC_SCHEMA_VERSION: 'v5',
      },
    });

    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);

    // Read the last 3 commit subjects in chronological order (oldest first).
    const logOut = git(['log', '--format=%s', '-3', '--reverse', 'HEAD'], root).trim();
    const subjects = logOut.split('\n');
    const taskMoveIdx = subjects.findIndex((s) => s.includes('auto-close'));
    const attestIdx = subjects.findIndex((s) => s.includes('auto-sign attestation'));

    assert.ok(taskMoveIdx !== -1, `task-move chore commit must exist in log:\n${logOut}`);
    assert.ok(attestIdx !== -1, `attestation-sign chore commit must exist in log:\n${logOut}`);
    assert.ok(
      taskMoveIdx < attestIdx,
      `task-move (idx ${taskMoveIdx}) must appear BEFORE attestation-sign (idx ${attestIdx}) — contentHashV4 load-bearing ordering:\n${logOut}`,
    );
  });

  // ── Idempotency: second push after orchestrator fired ───────────────────

  it('exits 0 on second push after all fixups already ran', () => {
    const TASK_ID = 'AISDLC-800';
    setupAttestationConditions(root, TASK_ID);

    writeTaskFile(root, TASK_ID);
    git(['add', '.'], root);
    git(['commit', '-q', '-m', `feat: idempotency test (${TASK_ID})`], root);

    const taskCmd = installFakeTaskCli(root);
    const signCmd = installFakeSignAttestation(root);
    const sharedEnv = {
      AI_SDLC_TASK_COMPLETE_CMD: taskCmd,
      AI_SDLC_SIGN_ATTESTATION_CMD: signCmd,
      AI_SDLC_TEST_MODE: '1',
      AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD: 'true',
      AI_SDLC_V6_CUTOVER_ACTIVE: '1',
      AI_SDLC_SCHEMA_VERSION: 'v5',
    };

    // First push: fixups run → exit 1.
    const r1 = runOrchestrator(root, { env: sharedEnv });
    assert.equal(r1.status, 1, `first push must exit 1, got ${r1.status}: ${r1.stderr}`);

    // Second push: all fixups already done → exit 0.
    const headAfterFirst = git(['rev-parse', 'HEAD'], root).trim();
    const r2 = runOrchestrator(root, { env: sharedEnv });
    assert.equal(
      r2.status,
      0,
      `second push (after fixups) must exit 0, got ${r2.status}: ${r2.stderr}`,
    );

    // HEAD must not change on second push.
    const headAfterSecond = git(['rev-parse', 'HEAD'], root).trim();
    assert.equal(headAfterSecond, headAfterFirst, 'second push must not add any commits');
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

  it('check-attestation-sign.sh still exits 1 when invoked directly (no AI_SDLC_INTERNAL_NO_EXIT_1)', () => {
    const attestScript = join(PROJECT_ROOT, 'scripts', 'check-attestation-sign.sh');
    const TASK_ID = 'AISDLC-902';
    setupAttestationConditions(root, TASK_ID);

    writeFileSync(join(root, 'some-code.ts'), 'export const y = 2;\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', `feat: standalone attest test (${TASK_ID})`], root);

    const signCmd = installFakeSignAttestation(root);
    const NULL_SHA = '0000000000000000000000000000000000000000';
    const localSha = git(['rev-parse', 'HEAD'], root).trim();
    const stdinData = `refs/heads/main ${localSha} refs/remotes/origin/main ${NULL_SHA}\n`;

    const r = spawnSync('bash', [attestScript], {
      cwd: root,
      env: cleanEnv({
        AI_SDLC_SIGN_ATTESTATION_CMD: signCmd,
        AI_SDLC_TEST_MODE: '1',
        AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD: 'true',
        AI_SDLC_V6_CUTOVER_ACTIVE: '1',
        AI_SDLC_SCHEMA_VERSION: 'v5',
      }),
      input: stdinData,
      encoding: 'utf-8',
    });

    assert.equal(
      r.status,
      1,
      `standalone check-attestation-sign.sh must exit 1, got ${r.status}: ${r.stderr}`,
    );
  });

  // ── .husky/pre-push wiring assertion ─────────────────────────────────────

  it('.husky/pre-push invokes pre-push-fixups.sh AFTER check-coverage.sh and BEFORE check-task-moved.sh', () => {
    const prePushPath = join(PROJECT_ROOT, '.husky', 'pre-push');
    assert.equal(existsSync(prePushPath), true, `.husky/pre-push must exist at ${prePushPath}`);

    const content = readFileSync(prePushPath, 'utf-8');
    const lines = content.split('\n');

    const coverageIdx = lines.findIndex((l) => l.includes('check-coverage.sh'));
    const fixupsIdx = lines.findIndex((l) => l.includes('pre-push-fixups.sh'));
    const taskMoveIdx = lines.findIndex(
      (l) => l.includes('check-task-moved.sh') && !l.trimStart().startsWith('#'),
    );
    const attestationIdx = lines.findIndex(
      (l) => l.includes('check-attestation-sign.sh') && !l.trimStart().startsWith('#'),
    );

    assert.ok(coverageIdx !== -1, `check-coverage.sh must be in .husky/pre-push:\n${content}`);
    assert.ok(fixupsIdx !== -1, `pre-push-fixups.sh must be in .husky/pre-push:\n${content}`);
    assert.ok(taskMoveIdx !== -1, `check-task-moved.sh must be in .husky/pre-push:\n${content}`);
    assert.ok(
      attestationIdx !== -1,
      `check-attestation-sign.sh must be in .husky/pre-push:\n${content}`,
    );

    // check-mcp-bundle-sync.sh must NOT appear as an executable line (AISDLC-385 deleted it).
    const mcpBundleIdx = lines.findIndex(
      (l) => l.includes('check-mcp-bundle-sync.sh') && !l.trimStart().startsWith('#'),
    );
    assert.equal(
      mcpBundleIdx,
      -1,
      `check-mcp-bundle-sync.sh must NOT appear as an executable line in .husky/pre-push (deleted by AISDLC-385):\n${content}`,
    );

    assert.ok(
      coverageIdx < fixupsIdx,
      `check-coverage.sh (line ${coverageIdx + 1}) must appear BEFORE pre-push-fixups.sh (line ${fixupsIdx + 1})`,
    );
    assert.ok(
      fixupsIdx < taskMoveIdx,
      `pre-push-fixups.sh (line ${fixupsIdx + 1}) must appear BEFORE check-task-moved.sh (line ${taskMoveIdx + 1}) — orchestrator pre-empts individual hooks`,
    );
    assert.ok(
      fixupsIdx < attestationIdx,
      `pre-push-fixups.sh (line ${fixupsIdx + 1}) must appear BEFORE check-attestation-sign.sh (line ${attestationIdx + 1})`,
    );
  });
});
