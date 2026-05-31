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
  // Post-AISDLC-383.7: the AISDLC-380 sub-attestation gate was removed.
  // These env vars are no longer consulted by check-attestation-sign.sh
  // but we still scrub them defensively in case host env carries stale values.
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
 * AISDLC-475: the hook now looks for a patch-id-addressed file first
 * (<patch-id>.dsse.json or <patch-id>.v6.dsse.json). The stub must mirror
 * the same patch-id computation logic as check-attestation-sign.sh so it
 * writes to the filename the hook expects.
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

# AISDLC-475: compute patch-id using the same exclusion list as the hook so
# the signer writes to the patch-id-addressed filename that the hook checks.
MERGE_BASE=$(git merge-base "origin/main" HEAD 2>/dev/null || echo '')
PATCH_ID=""
if [ -n "\$MERGE_BASE" ] && [ \${#MERGE_BASE} -eq 40 ]; then
  DIFF_OUTPUT=$(git diff-tree --no-color -p "\${MERGE_BASE}..HEAD" -- ':!.ai-sdlc/attestations/' ':!.ai-sdlc/transcript-leaves/' ':!.ai-sdlc/transcript-leaves.jsonl' 2>/dev/null || echo '')
  if [ -n "\$DIFF_OUTPUT" ]; then
    PATCH_ID_LINE=$(printf '%s' "\$DIFF_OUTPUT" | git patch-id --stable 2>/dev/null | head -1 || echo '')
    PATCH_ID=$(printf '%s' "\$PATCH_ID_LINE" | cut -c1-40 2>/dev/null || echo '')
    if ! printf '%s' "\$PATCH_ID" | grep -qE '^[0-9a-f]{40}$'; then
      PATCH_ID=""
    fi
  fi
fi

# Determine the envelope filename: patch-id-addressed when available (matches hook),
# otherwise fall back to per-SHA (matches hook's fallback).
if [ "\${SCHEMA:-v5}" = "v6" ]; then
  if [ -n "\$PATCH_ID" ]; then
    ATT_FILE="\$WT_ROOT/.ai-sdlc/attestations/\$PATCH_ID.v6.dsse.json"
  else
    ATT_FILE="\$WT_ROOT/.ai-sdlc/attestations/\$HEAD_SHA.v6.dsse.json"
  fi
else
  if [ -n "\$PATCH_ID" ]; then
    ATT_FILE="\$WT_ROOT/.ai-sdlc/attestations/\$PATCH_ID.dsse.json"
  else
    ATT_FILE="\$WT_ROOT/.ai-sdlc/attestations/\$HEAD_SHA.dsse.json"
  fi
fi
echo '{"fake":"attestation"}' > "\$ATT_FILE"
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
  // AISDLC-490 B+: when ONLY attestation-sign runs (task-move is a no-op),
  // the orchestrator exits 0 because the sign hook amends HEAD in place (no new
  // commit → commit count unchanged → FIXED array stays empty → exit 0).

  it('AISDLC-490 B+ (combo 01) exits 0 when only attestation-sign runs (amend, no re-push)', () => {
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
    const commitCountBefore = git(['rev-list', '--count', 'HEAD'], root).trim();

    const signCmd = installFakeSignAttestation(root);
    const r = runOrchestrator(root, {
      env: {
        AI_SDLC_SIGN_ATTESTATION_CMD: signCmd,
        AI_SDLC_TEST_MODE: '1',
        AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD: 'true',
        AI_SDLC_V6_CUTOVER_ACTIVE: '1',
        AI_SDLC_SCHEMA_VERSION: 'v5',
      },
    });

    // AISDLC-490 B+: attestation-sign amends (no new commit) → commit count unchanged
    // → orchestrator exits 0 (no re-push needed; push proceeds with amended commit).
    assert.equal(
      r.status,
      0,
      `AISDLC-490 B+: expected 0 (attestation-sign amends, no re-push), got ${r.status}: ${r.stderr}`,
    );
    // Commit count must stay the same (amend, not new commit).
    const commitCountAfter = git(['rev-list', '--count', 'HEAD'], root).trim();
    assert.equal(
      commitCountAfter,
      commitCountBefore,
      `AISDLC-490 B+: attestation-sign amend must NOT add a commit (before=${commitCountBefore} after=${commitCountAfter})`,
    );
  });

  // ── Combination 4: task-move + attestation-sign (1/1) ──────────────────
  // AISDLC-490 B+: when BOTH task-move and attestation-sign run:
  // - task-move creates a new chore commit → commit count grows → exits 1
  // - attestation-sign amends that chore commit (no additional commit)
  // The orchestrator exits 1 (because task-move added a new commit), but
  // only lists task-move in Auto-fixed (attestation-sign is amend-based,
  // commit count unchanged after attestation-sign).

  it('AISDLC-490 B+ (combo 11) exits 1 (task-move added commit), attestation amends task-move commit', () => {
    const TASK_ID = 'AISDLC-300';
    setupAttestationConditions(root, TASK_ID);

    writeTaskFile(root, TASK_ID);
    git(['add', '.'], root);
    git(['commit', '-q', '-m', `feat: dual fixup case (${TASK_ID})`], root);
    const commitCountBefore = git(['rev-list', '--count', 'HEAD'], root).trim();

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

    // Still exits 1 because task-move added a new commit.
    assert.equal(r.status, 1, `expected 1 (task-move added commit), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /Auto-fixed:/i);
    assert.match(r.stderr, /task-move/i);
    // AISDLC-490 B+: commit count grew by exactly 1 (task-move only; attestation-sign amended).
    const commitCountAfter = git(['rev-list', '--count', 'HEAD'], root).trim();
    assert.equal(
      parseInt(commitCountAfter) - parseInt(commitCountBefore),
      1,
      `AISDLC-490 B+: commit count must grow by 1 (task-move only) — before=${commitCountBefore} after=${commitCountAfter}`,
    );
  });

  // ── Ordering invariant ────────────────────────────────────────────────────

  it('AISDLC-490 B+: task-move runs BEFORE attestation-sign; attestation-sign amends task-move commit (not a new commit)', () => {
    // AISDLC-490 B+ changes the ordering contract:
    // - task-move still produces a NEW chore commit (auto-close subject)
    // - attestation-sign now AMENDS the task-move commit in place (no new commit)
    // The ordering invariant (task-move BEFORE sign) is preserved: the sign hook
    // runs second in the dependency chain, amending whatever HEAD happens to be
    // at that point (which is the task-move chore commit). The attestation envelope
    // is baked into the task-move commit, not into a separate "auto-sign" commit.
    const TASK_ID = 'AISDLC-700';
    setupAttestationConditions(root, TASK_ID);

    writeTaskFile(root, TASK_ID);
    git(['add', '.'], root);
    git(['commit', '-q', '-m', `feat: ordering test (${TASK_ID})`], root);
    const commitCountBefore = git(['rev-list', '--count', 'HEAD'], root).trim();

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

    // Task-move added a new commit → commit count grew → orchestrator exits 1.
    assert.equal(r.status, 1, `expected exit 1 (task-move ran), got ${r.status}: ${r.stderr}`);

    // Read the last 3 commit subjects in chronological order (oldest first).
    const logOut = git(['log', '--format=%s', '-3', '--reverse', 'HEAD'], root).trim();
    const subjects = logOut.split('\n');
    const taskMoveIdx = subjects.findIndex((s) => s.includes('auto-close'));

    assert.ok(taskMoveIdx !== -1, `task-move chore commit must exist in log:\n${logOut}`);
    // AISDLC-490 B+: attestation-sign amends the task-move commit, so no separate
    // "auto-sign attestation" commit exists in the log. The attestation envelope
    // is part of the task-move commit's tree.
    const attestIdx = subjects.findIndex((s) => s.includes('auto-sign attestation'));
    assert.equal(
      attestIdx,
      -1,
      `AISDLC-490 B+: no "auto-sign attestation" chore commit must exist in log — attestation is baked into the task-move commit:\n${logOut}`,
    );

    // Commit count: grew by exactly 1 (task-move only, no attestation-sign new commit).
    const commitCountAfter = git(['rev-list', '--count', 'HEAD'], root).trim();
    assert.equal(
      parseInt(commitCountAfter) - parseInt(commitCountBefore),
      1,
      `AISDLC-490 B+: commit count must grow by exactly 1 (task-move only, attestation-sign amends it) — before=${commitCountBefore} after=${commitCountAfter}`,
    );
  });

  // ── Idempotency: second push after orchestrator fired ───────────────────

  it('exits 0 on second push after all fixups already ran (task-move + attestation-sign)', () => {
    // AISDLC-490 B+: first push → task-move adds new commit (exit 1).
    // Second push → task-move sees file already in completed/ (no-op), attestation-sign
    // sees patch-id envelope exists (idempotent skip) → both exit 0 → orchestrator exits 0.
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

    // First push: task-move adds a new commit → exit 1.
    const r1 = runOrchestrator(root, { env: sharedEnv });
    assert.equal(
      r1.status,
      1,
      `first push must exit 1 (task-move added commit), got ${r1.status}: ${r1.stderr}`,
    );

    // Second push: all fixups already done → exit 0.
    const headAfterFirst = git(['rev-parse', 'HEAD'], root).trim();
    const r2 = runOrchestrator(root, { env: sharedEnv });
    assert.equal(
      r2.status,
      0,
      `second push (after fixups) must exit 0, got ${r2.status}: ${r2.stderr}`,
    );

    // HEAD must not change on second push (no new commits, no amend triggered).
    const headAfterSecond = git(['rev-parse', 'HEAD'], root).trim();
    assert.equal(headAfterSecond, headAfterFirst, 'second push must not change HEAD');
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

  it('AISDLC-490 B+: check-attestation-sign.sh exits 0 when invoked directly (amend-based, no re-push)', () => {
    // AISDLC-490 B+ change: the hook now amends instead of creating a new chore commit,
    // so it exits 0 in BOTH standalone and orchestrator modes. The old exit-1 behavior
    // was the source of the re-sign loop — eliminating it here is the structural fix.
    const attestScript = join(PROJECT_ROOT, 'scripts', 'check-attestation-sign.sh');
    const TASK_ID = 'AISDLC-902';
    setupAttestationConditions(root, TASK_ID);

    writeFileSync(join(root, 'some-code.ts'), 'export const y = 2;\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', `feat: standalone attest test (${TASK_ID})`], root);
    const commitCountBefore = git(['rev-list', '--count', 'HEAD'], root).trim();

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

    // AISDLC-490 B+: exits 0 (amend, push proceeds immediately).
    assert.equal(
      r.status,
      0,
      `AISDLC-490 B+: standalone check-attestation-sign.sh must exit 0 (amend-based), got ${r.status}: ${r.stderr}`,
    );
    // Commit count must NOT increase (amend, not new commit).
    const commitCountAfter = git(['rev-list', '--count', 'HEAD'], root).trim();
    assert.equal(
      commitCountAfter,
      commitCountBefore,
      `AISDLC-490 B+: amend must NOT add a new commit (before=${commitCountBefore} after=${commitCountAfter})`,
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
