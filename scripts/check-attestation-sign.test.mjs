/**
 * Tests for `scripts/check-attestation-sign.sh` — AISDLC-133.
 *
 * The script is invoked from `.husky/pre-push` AFTER the coverage gate. It
 * auto-signs a DSSE attestation when (1) the worktree has an active-task
 * sentinel, (2) a verdict file exists at <worktree>/.ai-sdlc/verdicts/, and
 * (3) no attestation exists yet at current HEAD. When all three conditions
 * are met it signs + commits the envelope + exits 1 with "re-push required".
 *
 * The signer command is overridable via AI_SDLC_SIGN_ATTESTATION_CMD so we
 * stub it with a tiny shell script that just `cp`s a fixture into place.
 * This keeps the tests hermetic — no orchestrator build, no signing key,
 * no node sub-process beyond what node:test itself spawns.
 *
 * Run with: node --test scripts/check-attestation-sign.test.mjs
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
  readdirSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-attestation-sign.sh');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  // Don't inherit stale overrides from the host env.
  delete env.AI_SDLC_BYPASS_ALL_GATES;
  delete env.AI_SDLC_SKIP_ATTESTATION_SIGN;
  delete env.AI_SDLC_SIGN_ATTESTATION_CMD;
  delete env.AI_SDLC_ITERATION_COUNT;
  delete env.AI_SDLC_HARNESS_NOTE;
  // AISDLC-383.6: schema version env vars must not leak from operator shell.
  delete env.AI_SDLC_SCHEMA_VERSION;
  delete env.AI_SDLC_V6_CUTOVER_ACTIVE;
  // AISDLC-383.6 default: most tests assume cutover-active (so v6 is the
  // effective default + AISDLC-380 gate is audit-only). Tests that
  // specifically need the gated/non-cutover state pass an explicit
  // AI_SDLC_V6_CUTOVER_ACTIVE: '0' (or any non-'1' value) in `extra`.
  if (!('AI_SDLC_V6_CUTOVER_ACTIVE' in extra)) {
    env.AI_SDLC_V6_CUTOVER_ACTIVE = '1';
  }
  // AISDLC-250: don't inherit CODEX_VERSION from the host env so tests that
  // assert the "absent" path are hermetic even when the operator has exported it.
  delete env.CODEX_VERSION;
  // AISDLC-383.7: the AISDLC-380 sub-attestation gate (Step 4d) was removed in
  // Phase 4 cleanup. The associated AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD +
  // AI_SDLC_TEST_MODE env vars are no longer consulted by the hook; tests no
  // longer need to inject a stub verifier.
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf-8' });
}

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-attestation-sign-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  // Baseline commit so HEAD exists (the script reads `git rev-parse HEAD`).
  writeFileSync(join(root, 'README.md'), 'baseline\n');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'baseline'], root);
  // Synthesize an `origin/main` ref pointing at the baseline so the stale-envelope
  // detection (Step 4c) can compute `git diff origin/main..HEAD`. Tests that
  // simulate dev branches MUST configure this baseline ref.
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], root);
  return root;
}

/**
 * Install a fake signer script at `<root>/bin/fake-signer.sh` that writes a
 * stub attestation file at `.ai-sdlc/attestations/<head-sha>.dsse.json` and
 * (when withLeaves=true) a per-patch-id transcript-leaves file at
 * `.ai-sdlc/transcript-leaves/<head-sha>.jsonl`.
 * Returns an absolute command string suitable for AI_SDLC_SIGN_ATTESTATION_CMD.
 *
 * @param {string} root  worktree root
 * @param {object} opts
 * @param {boolean} [opts.fail=false]       if true, the signer exits non-zero
 *   without writing the file (simulates orchestrator-not-built or signing-key
 *   missing).
 * @param {boolean} [opts.silent=false]     if true, the signer exits 0 but does
 *   NOT write the attestation file (simulates a buggy signer that doesn't
 *   produce its expected output).
 * @param {boolean} [opts.withLeaves=false] AISDLC-471: if true, the signer
 *   also writes a per-patch-id transcript-leaves file at
 *   `.ai-sdlc/transcript-leaves/<head-sha>.jsonl` (simulates the real signer's
 *   `cli-attestation.mjs emit-leaf` step that AISDLC-421 introduced).
 */
function installFakeSigner(root, { fail = false, silent = false, withLeaves = false } = {}) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(root, 'signer.log');
  const shimPath = join(binDir, 'fake-signer.sh');
  const failBlock = fail ? 'exit 7' : '';
  // RFC-0042 Phase 3 / AISDLC-475 Fix B: schema-version-aware fake signer.
  // v6 → write to <patch-id>.v6.dsse.json (primary, AISDLC-475) OR
  //       fall back to <sha>.v6.dsse.json when no patch-id is computable.
  // v5 (or anything else) → <sha>.dsse.json.
  //
  // AISDLC-475: the real signer now writes ONLY the patch-id file (no SHA bridge).
  // The fake signer must mirror this so the hook's confirmation check passes.
  // We compute the patch-id using the same exclusion list as the hook and signer.
  const writeBlock = silent
    ? '# silent mode: do not write the file'
    : `mkdir -p "$WT_ROOT/.ai-sdlc/attestations"
SCHEMA_VERSION_ARG="v6"
prev_was_schema=0
for arg in "$@"; do
  if [ "$prev_was_schema" = "1" ]; then SCHEMA_VERSION_ARG="$arg"; break; fi
  if [ "$arg" = "--schema-version" ]; then prev_was_schema=1; else prev_was_schema=0; fi
done
# Simpler: grep --schema-version arg from $*
if echo "$*" | grep -q -- "--schema-version v5"; then
  SCHEMA_VERSION_ARG="v5"
fi
if [ "$SCHEMA_VERSION_ARG" = "v6" ]; then
  EXT=".v6.dsse.json"
  # AISDLC-475 Fix B: compute patch-id using canonical 3-entry exclusion list.
  # Write to <patch-id>.v6.dsse.json (primary), same as the real signer.
  FAKE_MERGE_BASE=$(git merge-base "origin/main" HEAD 2>/dev/null || echo '')
  FAKE_PATCH_ID=""
  if [ -n "$FAKE_MERGE_BASE" ] && [ \${#FAKE_MERGE_BASE} -eq 40 ]; then
    FAKE_DIFF=$(git diff-tree --no-color -p "\${FAKE_MERGE_BASE}..HEAD" -- ':!.ai-sdlc/attestations/' ':!.ai-sdlc/transcript-leaves/' ':!.ai-sdlc/transcript-leaves.jsonl' 2>/dev/null || echo '')
    if [ -n "$FAKE_DIFF" ]; then
      FAKE_PATCH_ID_LINE=$(printf '%s' "$FAKE_DIFF" | git patch-id --stable 2>/dev/null | head -1 || echo '')
      FAKE_PATCH_ID=$(printf '%s' "$FAKE_PATCH_ID_LINE" | cut -c1-40 2>/dev/null || echo '')
      if ! printf '%s' "$FAKE_PATCH_ID" | grep -qE '^[0-9a-f]{40}$'; then
        FAKE_PATCH_ID=""
      fi
    fi
  fi
  if [ -n "$FAKE_PATCH_ID" ]; then
    ENVELOPE_KEY="$FAKE_PATCH_ID"
  else
    ENVELOPE_KEY="$HEAD"
  fi
else
  EXT=".dsse.json"
  ENVELOPE_KEY="$HEAD"
fi
printf '{"_test":"stub","head":"%s","schemaVersion":"%s"}\\n' "$HEAD" "$SCHEMA_VERSION_ARG" > "$WT_ROOT/.ai-sdlc/attestations/$ENVELOPE_KEY$EXT"`;
  // AISDLC-471: optionally write a per-patch-id transcript-leaves file so the
  // test can assert that the hook commits it alongside the envelope.
  const leavesBlock = withLeaves
    ? `mkdir -p "$WT_ROOT/.ai-sdlc/transcript-leaves"
printf '{"_test":"stub-leaf","head":"%s"}\\n' "$HEAD" > "$WT_ROOT/.ai-sdlc/transcript-leaves/$HEAD.jsonl"`
    : '# withLeaves=false: skip transcript-leaves write';
  const shim = `#!/usr/bin/env bash
echo "fake-signer $*" >> "${logPath}"
${failBlock}
WT_ROOT=$(git rev-parse --show-toplevel)
HEAD=$(git rev-parse HEAD)
${writeBlock}
${leavesBlock}
exit 0
`;
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  return { cmd: `bash ${shimPath}`, logPath };
}

function writeVerdictFile(root, taskId) {
  const dir = join(root, '.ai-sdlc', 'verdicts');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${taskId.toLowerCase()}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      [
        {
          agentId: 'code-reviewer',
          harness: 'claude-code',
          approved: true,
          findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        },
      ],
      null,
      2,
    ) + '\n',
  );
  return path;
}

function runHook(cwd, env = {}) {
  return spawnSync('bash', [SCRIPT], {
    cwd,
    env: cleanEnv(env),
    encoding: 'utf-8',
  });
}

describe('check-attestation-sign.sh (AISDLC-133)', () => {
  let root;

  beforeEach(() => {
    root = setupRepo();
    chmodSync(SCRIPT, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('AI_SDLC_BYPASS_ALL_GATES=1 exits 0 immediately even when ready to sign', () => {
    // Even with a sentinel + verdict + no existing attestation, the master
    // bypass must prevent any sign or commit from happening.
    writeFileSync(join(root, '.active-task'), 'AISDLC-383\n');
    writeVerdictFile(root, 'AISDLC-383');
    const headBefore = git(['rev-parse', 'HEAD'], root).trim();

    const { cmd, logPath } = installFakeSigner(root);
    const r = runHook(root, {
      AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
      AI_SDLC_BYPASS_ALL_GATES: '1',
    });

    assert.equal(r.status, 0, `expected exit 0 with bypass, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /AI_SDLC_BYPASS_ALL_GATES=1/);
    // Signer must NOT be invoked.
    assert.equal(existsSync(logPath), false, 'signer must NOT run when bypass is set');
    // No new commit must land.
    const headAfter = git(['rev-parse', 'HEAD'], root).trim();
    assert.equal(headAfter, headBefore, 'HEAD must not change when bypass is set');
  });

  it('AI_SDLC_BYPASS_ALL_GATES=0 does NOT bypass (falls through to normal sentinel check)', () => {
    // When the var is 0, the bypass must not fire; normal no-op for missing sentinel.
    const r = runHook(root, { AI_SDLC_BYPASS_ALL_GATES: '0' });
    // No sentinel → normal exit 0.
    assert.equal(r.status, 0, `expected exit 0 (no-sentinel path), got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /AI_SDLC_BYPASS_ALL_GATES=1/);
  });

  it('AC #2: exits 0 when the active-task sentinel is absent (chore PR / ad-hoc)', () => {
    // No .active-task, no verdict file, no attestation. The hook must fall
    // through silently so chore PRs and docs-only commits push cleanly.
    const r = runHook(root);
    assert.equal(r.status, 0, `expected 0, got ${r.status}: stderr=${r.stderr}`);
  });

  it('exits 0 when the sentinel file exists but is empty (defensive)', () => {
    writeFileSync(join(root, '.active-task'), '\n');
    const r = runHook(root);
    assert.equal(r.status, 0, `expected 0 for empty sentinel, got ${r.status}: ${r.stderr}`);
    // The warn message just needs to mention "empty" — exact wording is allowed
    // to drift as the script evolves.
    assert.match(r.stderr, /empty/i);
  });

  it('AC #3: exits 0 when sentinel present but verdict file is absent', () => {
    // The verdict file is the explicit "ready to attest" handoff. Without
    // it, reviewers haven't run yet (or ran but didn't approve) — the hook
    // must let the push proceed (the verifier will mark missing).
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    const r = runHook(root);
    assert.equal(r.status, 0, `expected 0 with no verdict file, got ${r.status}: ${r.stderr}`);
  });

  it('AC #4: idempotent — exits 0 when v6 attestation already exists at HEAD (cutover active)', () => {
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    writeVerdictFile(root, 'AISDLC-133');
    // Simulate a pre-existing v6 attestation at current HEAD.
    // RFC-0042 Phase 3 cutover gated on AI_SDLC_V6_CUTOVER_ACTIVE=1.
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const attDir = join(root, '.ai-sdlc', 'attestations');
    mkdirSync(attDir, { recursive: true });
    writeFileSync(join(attDir, `${head}.v6.dsse.json`), '{"existing":true,"schemaVersion":"v6"}\n');
    const { cmd, logPath } = installFakeSigner(root, { fail: true });
    const r = runHook(root, {
      AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
      AI_SDLC_V6_CUTOVER_ACTIVE: '1',
    });
    assert.equal(r.status, 0, `expected 0 for idempotent skip, got ${r.status}: ${r.stderr}`);
    assert.equal(
      existsSync(logPath),
      false,
      'signer must NOT be invoked when attestation already exists',
    );
  });

  it('AC #4: idempotent — exits 0 when v5 attestation already exists at HEAD (v5 explicit)', () => {
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    writeVerdictFile(root, 'AISDLC-133');
    // Simulate a pre-existing attestation at current HEAD.
    // When schema is explicitly v5 → file is <sha>.dsse.json.
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const attDir = join(root, '.ai-sdlc', 'attestations');
    mkdirSync(attDir, { recursive: true });
    writeFileSync(join(attDir, `${head}.dsse.json`), '{"existing":true,"schemaVersion":"v5"}\n');
    // Even with a "fail-everything" signer, idempotent skip should NOT invoke it.
    const { cmd, logPath } = installFakeSigner(root, { fail: true });
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd, AI_SDLC_SCHEMA_VERSION: 'v5' });
    assert.equal(r.status, 0, `expected 0 for v5 idempotent skip, got ${r.status}: ${r.stderr}`);
    assert.equal(
      existsSync(logPath),
      false,
      'signer must NOT be invoked when v5 attestation already exists',
    );
  });

  it('AC #1+5: signs + commits + exits 1 when sentinel + verdict + no attestation (v6 default)', () => {
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    writeVerdictFile(root, 'AISDLC-133');
    const head = git(['rev-parse', 'HEAD'], root).trim();

    const { cmd } = installFakeSigner(root);
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });

    assert.equal(r.status, 1, `expected 1 (re-push required), got ${r.status}: ${r.stderr}`);
    // Re-push message must be actionable.
    assert.match(r.stderr, /re-run `git push`|re-push required|added an attestation/i);
    // RFC-0042 Phase 3: default is v6 → attestation file is <sha>.v6.dsse.json.
    // Attestation file must be present at the original HEAD.
    const attPath = join(root, '.ai-sdlc', 'attestations', `${head}.v6.dsse.json`);
    assert.equal(existsSync(attPath), true, 'v6 attestation file must exist after sign');
    // A new commit must have landed on top.
    const newHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(newHead, head, 'a chore commit must have been added on top of HEAD');
    const newSubject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.match(newSubject, /chore: auto-sign attestation for AISDLC-133/);
  });

  it('AC #5: re-push hint stays actionable (mentions the env-var deferral)', () => {
    // The re-push message must point the operator at the AI_SDLC_SKIP_ATTESTATION_SIGN
    // escape hatch so they can defer signing if they need to (e.g. they're
    // about to hand-resign with a different key).
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    writeVerdictFile(root, 'AISDLC-133');
    const { cmd } = installFakeSigner(root);
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /AI_SDLC_SKIP_ATTESTATION_SIGN=1/);
  });

  it('AC #9: AI_SDLC_SKIP_ATTESTATION_SIGN=1 short-circuits with exit 0 even when ready to sign', () => {
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    writeVerdictFile(root, 'AISDLC-133');
    const { cmd, logPath } = installFakeSigner(root);
    const r = runHook(root, {
      AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
      AI_SDLC_SKIP_ATTESTATION_SIGN: '1',
    });
    assert.equal(r.status, 0, `expected 0 with deferral, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /AI_SDLC_SKIP_ATTESTATION_SIGN=1/);
    // Signer must NOT be invoked when deferral is set.
    assert.equal(existsSync(logPath), false, 'signer must NOT run under deferral');
    // No new commit must land.
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const subject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.match(subject, /baseline/, `HEAD ${head} should still be the baseline commit`);
  });

  it('exits 2 when the signer command fails (does not abort push silently)', () => {
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    writeVerdictFile(root, 'AISDLC-133');
    const { cmd } = installFakeSigner(root, { fail: true });
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(r.status, 2, `expected 2 for signer failure, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /signer invocation \(override\) failed/);
  });

  it('exits 2 when the signer reports success but writes no envelope (defensive)', () => {
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    writeVerdictFile(root, 'AISDLC-133');
    const { cmd } = installFakeSigner(root, { silent: true });
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(
      r.status,
      2,
      `expected 2 for silent-no-output signer, got ${r.status}: ${r.stderr}`,
    );
    assert.match(r.stderr, /signer did not produce/);
  });

  it('accepts uppercase task IDs in the sentinel and resolves the lowercase verdict file', () => {
    // The active-task sentinel stores the canonical uppercase ID
    // (`AISDLC-133`), but the verdict file convention is lowercase
    // (`<task-id-lower>.json`). The hook must resolve both forms.
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    writeVerdictFile(root, 'AISDLC-133'); // writes to aisdlc-133.json
    const { cmd, logPath } = installFakeSigner(root);
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(r.status, 1, `expected 1 (signed), got ${r.status}: ${r.stderr}`);
    // The signer must have been invoked with the lowercase verdict path.
    const log = execFileSync('cat', [logPath], { encoding: 'utf-8' });
    assert.match(log, /aisdlc-133\.json/, `signer log must mention lowercase verdict: ${log}`);
  });

  it('passes AI_SDLC_ITERATION_COUNT through to the signer', () => {
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    writeVerdictFile(root, 'AISDLC-133');
    const { cmd, logPath } = installFakeSigner(root);
    const r = runHook(root, {
      AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
      AI_SDLC_ITERATION_COUNT: '2',
    });
    assert.equal(r.status, 1);
    const log = execFileSync('cat', [logPath], { encoding: 'utf-8' });
    assert.match(log, /--iteration-count 2/, `signer log must reflect iteration count: ${log}`);
  });

  it('AISDLC-135: loop prevention — second push with HEAD as auto-sign chore is a no-op', () => {
    // Reproduction of PR #168's loop. First push:
    //   HEAD = dev commit, no envelope, no chore subject — hook fires,
    //   signs envelope, commits chore, exits 1.
    // Second push (HEAD is now the chore the first push added):
    //   The envelope-at-HEAD check MISSES (the envelope was bound to the
    //   parent's SHA, not the chore commit's own SHA — committing the
    //   envelope changes HEAD). Without the AISDLC-135 subject predicate,
    //   the hook re-fires here, signs again, commits another chore,
    //   exits 1 — and loops indefinitely. With the predicate, the second
    //   push falls through with exit 0 and zero side-effects.
    writeFileSync(join(root, '.active-task'), 'AISDLC-135\n');
    writeVerdictFile(root, 'AISDLC-135');

    // ── First push ────────────────────────────────────────────────
    const devHead = git(['rev-parse', 'HEAD'], root).trim();
    const { cmd, logPath } = installFakeSigner(root);
    const r1 = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(r1.status, 1, `first push: expected 1, got ${r1.status}: ${r1.stderr}`);

    const choreHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(choreHead, devHead, 'first push must add a chore commit');
    const choreSubject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.match(choreSubject, /^chore: auto-sign attestation for AISDLC-135/);
    // RFC-0042 Phase 3: default v6 → <sha>.v6.dsse.json.
    const envelopePath = join(root, '.ai-sdlc', 'attestations', `${devHead}.v6.dsse.json`);
    assert.equal(existsSync(envelopePath), true, 'v6 envelope must exist at dev-commit SHA');

    // Snapshot signer-log size + commit count so we can prove the second
    // push doesn't write an envelope or add a commit.
    const logBefore = execFileSync('cat', [logPath], { encoding: 'utf-8' });
    const commitCountBefore = git(['rev-list', '--count', 'HEAD'], root).trim();

    // ── Second push (HEAD is the chore commit) ────────────────────
    const r2 = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(
      r2.status,
      0,
      `second push (HEAD is auto-sign chore) must be a no-op; got ${r2.status}: ${r2.stderr}`,
    );

    // No new commit landed.
    const commitCountAfter = git(['rev-list', '--count', 'HEAD'], root).trim();
    assert.equal(
      commitCountAfter,
      commitCountBefore,
      `second push must NOT add another chore commit (${commitCountBefore} -> ${commitCountAfter})`,
    );
    // Signer was NOT re-invoked.
    const logAfter = execFileSync('cat', [logPath], { encoding: 'utf-8' });
    assert.equal(
      logAfter,
      logBefore,
      'signer must NOT be invoked on the second push (HEAD is auto-sign chore)',
    );
    // No new envelope at the chore-commit SHA (check both v5 and v6 filenames).
    const choreEnvelopeV5 = join(root, '.ai-sdlc', 'attestations', `${choreHead}.dsse.json`);
    const choreEnvelopeV6 = join(root, '.ai-sdlc', 'attestations', `${choreHead}.v6.dsse.json`);
    assert.equal(
      existsSync(choreEnvelopeV5) || existsSync(choreEnvelopeV6),
      false,
      'no envelope must be written at the chore-commit SHA',
    );
  });

  it('AISDLC-135: hook STILL fires on a brand-new dev commit even when prior auto-sign chore commits exist in history', () => {
    // History: dev1 → chore1 (auto-sign for dev1) → dev2 (HEAD).
    // Subject of HEAD is "feat: ..." not "chore: auto-sign ..." so the
    // AISDLC-135 predicate must NOT short-circuit. The envelope-at-HEAD
    // check also misses (no envelope at dev2 yet). Hook should fire
    // normally: sign + commit + exit 1.
    writeFileSync(join(root, '.active-task'), 'AISDLC-135\n');
    writeVerdictFile(root, 'AISDLC-135');

    // ── Build dev1 → chore1 → dev2 history ────────────────────────
    // Step 1: dev1 — first sign cycle.
    writeFileSync(join(root, 'feature1.txt'), 'first feature\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: first feature'], root);
    const dev1 = git(['rev-parse', 'HEAD'], root).trim();
    const { cmd, logPath } = installFakeSigner(root);
    const rA = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(rA.status, 1, `chore1 sign cycle: expected 1, got ${rA.status}: ${rA.stderr}`);
    const chore1 = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(chore1, dev1);
    const chore1Subject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.match(chore1Subject, /^chore: auto-sign attestation for AISDLC-135/);

    // Step 2: dev2 — brand-new dev commit ON TOP of chore1.
    writeFileSync(join(root, 'feature2.txt'), 'second feature\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: second feature'], root);
    const dev2 = git(['rev-parse', 'HEAD'], root).trim();
    const dev2Subject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.match(dev2Subject, /^feat: second feature/);

    // ── Hook must fire for dev2 ──────────────────────────────────
    const logBefore = execFileSync('cat', [logPath], { encoding: 'utf-8' });
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(
      r.status,
      1,
      `hook must fire on a brand-new dev commit even when chore1 is in history; got ${r.status}: ${r.stderr}`,
    );

    // A new v6 envelope must have been written (AISDLC-475 Fix B: the fake signer
    // now writes the patch-id file, not the SHA file, so we check for ANY v6
    // envelope in the attestations directory instead of a specific SHA filename).
    const attDirForDev2 = join(root, '.ai-sdlc', 'attestations');
    const dev2EnvelopeFiles = existsSync(attDirForDev2)
      ? readdirSync(attDirForDev2).filter((f) => f.endsWith('.v6.dsse.json'))
      : [];
    assert.ok(dev2EnvelopeFiles.length > 0, 'a new v6 envelope must exist after dev2 sign cycle');

    // New chore commit on top.
    const newHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(newHead, dev2, 'a new chore commit must have been added on top of dev2');
    const newSubject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.match(newSubject, /^chore: auto-sign attestation for AISDLC-135/);

    // Signer was invoked again (log grew).
    const logAfter = execFileSync('cat', [logPath], { encoding: 'utf-8' });
    assert.notEqual(logAfter, logBefore, 'signer must be re-invoked for the brand-new dev commit');
  });

  // ── AISDLC-387: docs-only changeset with no verdict file is a no-op ─────────
  //
  // The AISDLC-215 docs-only auto-approve synthesis path was removed in AISDLC-387
  // because it is incompatible with the v6 signer (which requires transcript leaves).
  // Docs-only PRs are handled by CI (AISDLC-214). The hook must simply exit 0.

  it('AISDLC-387: docs-only changeset + missing verdict file → exit 0 (no-op, no synthesis)', () => {
    // A docs-only commit (README.md change) with an active-task sentinel but
    // no verdict file. The hook must exit 0 without synthesizing verdicts or
    // invoking the signer. CI (AISDLC-214) handles docs-only attestation.
    // NOTE: write .active-task AFTER the docs commit so git diff doesn't
    // include .active-task (in production .active-task is gitignored; the
    // test repo has no .gitignore, so we avoid git-adding it by writing
    // the sentinel after the commit that captures the docs-only files).

    // Add a docs-only commit so the PR diff shows a markdown-only change.
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\nContent.\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'docs: add guide'], root);

    // Write sentinel AFTER commit so it is not tracked/staged.
    writeFileSync(join(root, '.active-task'), 'AISDLC-387T\n');
    // No verdict file — docs-only PR with no reviewer fan-out.

    const headBefore = git(['rev-parse', 'HEAD'], root).trim();
    const { cmd, logPath } = installFakeSigner(root);

    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });

    // Hook must be a no-op: exits 0, no new commit, no envelope, no signer invocation.
    assert.equal(r.status, 0, `expected exit 0 (no-op), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /no verdicts file.*skipping/i);
    // Signer must NOT be invoked.
    assert.equal(existsSync(logPath), false, 'signer must NOT run when verdict file is absent');
    // HEAD must not change (no chore commit was added).
    const headAfter = git(['rev-parse', 'HEAD'], root).trim();
    assert.equal(headAfter, headBefore, 'HEAD must not change (no chore commit for docs-only)');
    // No envelope must exist.
    const attDir = join(root, '.ai-sdlc', 'attestations');
    assert.equal(existsSync(attDir), false, 'attestations dir must not exist when hook is a no-op');
  });

  // ── AISDLC-250: CODEX_VERSION env var harness passthrough ────────────────

  it('AISDLC-250: passes --harness-name codex --harness-version when CODEX_VERSION is set', () => {
    // When the operator pre-exports CODEX_VERSION="codex@0.128.0", the hook
    // must parse the version and forward --harness-name codex --harness-version 0.128.0
    // to the signer so the attestation envelope carries harness identification.
    writeFileSync(join(root, '.active-task'), 'AISDLC-250\n');
    writeVerdictFile(root, 'AISDLC-250');
    const { cmd, logPath } = installFakeSigner(root);
    const r = runHook(root, {
      AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
      CODEX_VERSION: 'codex@0.128.0',
    });
    assert.equal(r.status, 1, `expected 1 (signed), got ${r.status}: ${r.stderr}`);
    const log = execFileSync('cat', [logPath], { encoding: 'utf-8' });
    assert.match(
      log,
      /--harness-name codex/,
      `signer must be invoked with --harness-name codex: ${log}`,
    );
    assert.match(
      log,
      /--harness-version 0\.128\.0/,
      `signer must be invoked with --harness-version 0.128.0: ${log}`,
    );
  });

  it('AISDLC-250: does NOT pass --harness-name when CODEX_VERSION is absent', () => {
    // When CODEX_VERSION is not set (claude-code path), the hook must NOT pass
    // --harness-name or --harness-version — the back-compat path leaves harness
    // absent from the envelope (defaults to claude-code per AISDLC-202.3).
    writeFileSync(join(root, '.active-task'), 'AISDLC-250\n');
    writeVerdictFile(root, 'AISDLC-250');
    const { cmd, logPath } = installFakeSigner(root);
    const r = runHook(root, {
      AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
      // CODEX_VERSION intentionally absent (cleanEnv already deletes it if present)
    });
    assert.equal(r.status, 1, `expected 1 (signed), got ${r.status}: ${r.stderr}`);
    const log = execFileSync('cat', [logPath], { encoding: 'utf-8' });
    assert.equal(
      log.includes('--harness-name'),
      false,
      `signer must NOT receive --harness-name when CODEX_VERSION is unset: ${log}`,
    );
  });

  it('the chore commit body does NOT contain a CI-skip magic token (AISDLC-88 contract)', () => {
    // The auto-sign chore commit body would re-trigger every workflow on the
    // resulting PR if it carried [skip ci]/[ci skip]/etc. The check-skip-ci-marker
    // pre-push gate (AISDLC-88) would also fail the next push. Lock in the
    // contract here as a guard against a copy-paste regression.
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    writeVerdictFile(root, 'AISDLC-133');
    const { cmd } = installFakeSigner(root);
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
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

  // ── AISDLC-383.7: AISDLC-380 sub-attestation gate tests removed ─────
  //
  // Phase 4 cleanup deleted the Step 4d sub-attestation gate from the hook
  // (the gate had been audit-only since AISDLC-383.6, and v6 envelopes
  // already skipped it entirely). The tests for the gate's audit-only
  // and hard-fail modes are removed alongside the code they exercised.
  // v6-default behavior is covered by the AC #4 / AC #1+5 tests above
  // plus the v6-default + AISDLC-274 stale-envelope tests below.

  // ── RFC-0042 Phase 3: default schema version is v6 (AI_SDLC_SCHEMA_VERSION unset) ──

  it('RFC-0042 Phase 3: default schema version is v6 (AI_SDLC_SCHEMA_VERSION unset)', () => {
    // The hook must use v6 by default. Verify by checking that the signer is
    // invoked with --schema-version v6 (and the envelope lands at .v6.dsse.json).
    writeFileSync(join(root, '.active-task'), 'AISDLC-383H\n');
    writeVerdictFile(root, 'AISDLC-383H');
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const { cmd, logPath } = installFakeSigner(root);
    const r = runHook(root, {
      AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
      // AI_SDLC_SCHEMA_VERSION intentionally NOT set (should default to v6).
    });

    assert.equal(
      r.status,
      1,
      `expected exit 1 (v6 default: signed), got ${r.status}: stderr=${r.stderr}`,
    );
    const log = execFileSync('cat', [logPath], { encoding: 'utf-8' });
    assert.match(
      log,
      /--schema-version v6/,
      `signer must be invoked with --schema-version v6 by default: ${log}`,
    );
    const attPath = join(root, '.ai-sdlc', 'attestations', `${head}.v6.dsse.json`);
    assert.equal(existsSync(attPath), true, 'v6 envelope must exist at HEAD');
  });

  // ── AISDLC-274: stale-envelope detection ─────────────────────────────

  // ── AISDLC-471: per-patch-id transcript-leaves committed alongside envelope ──
  //
  // The bug: the hook's git add step only staged .ai-sdlc/attestations/, leaving
  // .ai-sdlc/transcript-leaves/<patch-id>.jsonl untracked. CI checks out the tree,
  // can't find the per-patch-id file, falls back to the legacy shared
  // .ai-sdlc/transcript-leaves.jsonl (which has leaves from OTHER PRs), recomputes
  // the wrong Merkle root, and fails with rootSignature mismatch.
  //
  // The fix: also `git add .ai-sdlc/transcript-leaves/` in the chore commit step
  // so the per-patch-id leaves file travels with the envelope.

  it('AISDLC-471: chore commit includes per-patch-id transcript-leaves file when signer writes it', () => {
    // Set up: sentinel + verdict + fake signer that writes both the envelope
    // AND a per-patch-id transcript-leaves file (simulates the real signer's
    // cli-attestation.mjs emit-leaf step from AISDLC-421).
    writeFileSync(join(root, '.active-task'), 'AISDLC-471\n');
    writeVerdictFile(root, 'AISDLC-471');
    const head = git(['rev-parse', 'HEAD'], root).trim();

    const { cmd } = installFakeSigner(root, { withLeaves: true });
    const r = runHook(root, {
      AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
      AI_SDLC_INTERNAL_NO_EXIT_1: '1',
    });

    assert.equal(r.status, 0, `expected 0 (orchestrator mode), got ${r.status}: ${r.stderr}`);

    // AC #1: envelope must be committed (pre-existing behavior).
    const envelopeInTree = spawnSync(
      'git',
      ['ls-tree', 'HEAD', '--', `.ai-sdlc/attestations/${head}.v6.dsse.json`],
      { cwd: root, encoding: 'utf-8' },
    );
    assert.ok(
      envelopeInTree.stdout.trim().length > 0,
      `envelope must be committed: git ls-tree output was empty (stderr: ${envelopeInTree.stderr})`,
    );

    // AC #2 (load-bearing for AISDLC-471): per-patch-id leaves file must be committed.
    const leavesInTree = spawnSync(
      'git',
      ['ls-tree', 'HEAD', '--', `.ai-sdlc/transcript-leaves/${head}.jsonl`],
      { cwd: root, encoding: 'utf-8' },
    );
    assert.ok(
      leavesInTree.stdout.trim().length > 0,
      `per-patch-id leaves file must be committed alongside the envelope — ` +
        `this is the AC #2 regression guard for AISDLC-471. ` +
        `git ls-tree output was empty (stderr: ${leavesInTree.stderr})`,
    );
  });

  it('AISDLC-471: backward-compat — hook still works when signer writes no leaves file (empty dir)', () => {
    // When the signer does not emit per-patch-id leaves (e.g. ad-hoc operator
    // signing, or a caller that has not yet wired cli-attestation.mjs emit-leaf),
    // the hook must still succeed: just commits the envelope without the leaves
    // file. `git add` of a non-existent/empty directory is a no-op.
    writeFileSync(join(root, '.active-task'), 'AISDLC-471\n');
    writeVerdictFile(root, 'AISDLC-471');
    const head = git(['rev-parse', 'HEAD'], root).trim();

    // withLeaves: false → signer does NOT write .ai-sdlc/transcript-leaves/
    const { cmd } = installFakeSigner(root, { withLeaves: false });
    const r = runHook(root, {
      AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
      AI_SDLC_INTERNAL_NO_EXIT_1: '1',
    });

    assert.equal(
      r.status,
      0,
      `expected 0 (orchestrator mode, no leaves), got ${r.status}: ${r.stderr}`,
    );

    // Envelope must still be committed (primary function intact).
    const envelopeInTree = spawnSync(
      'git',
      ['ls-tree', 'HEAD', '--', `.ai-sdlc/attestations/${head}.v6.dsse.json`],
      { cwd: root, encoding: 'utf-8' },
    );
    assert.ok(
      envelopeInTree.stdout.trim().length > 0,
      `envelope must be committed even when no leaves file exists: ${envelopeInTree.stderr}`,
    );

    // No leaves file must have been sneaked into the commit tree (it simply
    // doesn't exist — the absence is fine, the hook must not error).
    const leavesInTree = spawnSync(
      'git',
      ['ls-tree', 'HEAD', '--', `.ai-sdlc/transcript-leaves/${head}.jsonl`],
      { cwd: root, encoding: 'utf-8' },
    );
    assert.equal(
      leavesInTree.stdout.trim(),
      '',
      'no leaves file should appear in the commit tree when none was written by the signer',
    );
  });

  it('AISDLC-472: STANDALONE exit-1 path commits per-patch-id leaves (normal pre-push, no orchestrator)', () => {
    // The existing withLeaves coverage (AISDLC-471) only exercises orchestrator
    // mode (AI_SDLC_INTERNAL_NO_EXIT_1=1 → exit 0). This test covers the normal
    // standalone pre-push invocation: leaves present, NO orchestrator env var,
    // so the hook signs + commits the envelope + the per-patch-id leaves file
    // AND exits 1 with the "re-push required" hint. Guards the load-bearing
    // AISDLC-471 staging behavior on the exit-1 code path operators actually hit.
    writeFileSync(join(root, '.active-task'), 'AISDLC-472\n');
    writeVerdictFile(root, 'AISDLC-472');
    const head = git(['rev-parse', 'HEAD'], root).trim();

    const { cmd } = installFakeSigner(root, { withLeaves: true });
    // NOTE: no AI_SDLC_INTERNAL_NO_EXIT_1 → standalone mode → exit 1 expected.
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });

    assert.equal(r.status, 1, `expected 1 (re-push required), got ${r.status}: ${r.stderr}`);
    // Re-push message must be actionable (mirrors the AC #1+5 standalone test).
    assert.match(r.stderr, /re-run `git push`|re-push required|added an attestation/i);

    // Envelope must be committed.
    const envelopeInTree = spawnSync(
      'git',
      ['ls-tree', 'HEAD', '--', `.ai-sdlc/attestations/${head}.v6.dsse.json`],
      { cwd: root, encoding: 'utf-8' },
    );
    assert.ok(
      envelopeInTree.stdout.trim().length > 0,
      `envelope must be committed on the standalone exit-1 path: ${envelopeInTree.stderr}`,
    );

    // Load-bearing AISDLC-471 guard: per-patch-id leaves file must be committed
    // alongside the envelope on the standalone exit-1 path too.
    const leavesInTree = spawnSync(
      'git',
      ['ls-tree', 'HEAD', '--', `.ai-sdlc/transcript-leaves/${head}.jsonl`],
      { cwd: root, encoding: 'utf-8' },
    );
    assert.ok(
      leavesInTree.stdout.trim().length > 0,
      `per-patch-id leaves file must be committed on the standalone exit-1 path — ` +
        `this is the AISDLC-472 regression guard. ` +
        `git ls-tree output was empty (stderr: ${leavesInTree.stderr})`,
    );

    // A chore commit must have landed on top of the original HEAD.
    const newHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(newHead, head, 'a chore commit must have been added on top of HEAD');
    const newSubject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.match(newSubject, /chore: auto-sign attestation for AISDLC-472/);
  });

  it('AISDLC-274: hook removes stale envelope + signs fresh after queue-rebase simulation', () => {
    // Simulates the rebase-stale case: there is an envelope file in
    // .ai-sdlc/attestations/ from a prior sign cycle, but its filename SHA
    // is NOT HEAD~1 (the rebase shifted the parent SHA). The hook must
    // detect the stale envelope, remove it, and proceed to sign fresh.
    //
    // Setup:
    //   baseline (origin/main) → dev commit → chore commit (has old envelope)
    //   Then: add a NEW dev commit (simulating post-rebase code change).
    //   HEAD is now the new dev commit. HEAD~1 is the chore commit.
    //   The old envelope in .ai-sdlc/attestations/ has an unrelated SHA.
    //
    // Expected: hook fires (no envelope at HEAD), removes the stale file,
    // signs fresh, commits a new chore, exits 1.

    writeFileSync(join(root, '.active-task'), 'AISDLC-274\n');
    writeVerdictFile(root, 'AISDLC-274');

    // Simulate a stale envelope from a prior sign cycle: write an envelope
    // with a random (non-existent) SHA filename. This represents what happens
    // after a queue rebase — the old SHA is no longer on the branch.
    const staleShaPart = '0000000000000000000000000000000000000001';
    const attDir = join(root, '.ai-sdlc', 'attestations');
    mkdirSync(attDir, { recursive: true });
    const staleEnvPath = join(attDir, `${staleShaPart}.dsse.json`);
    writeFileSync(staleEnvPath, '{"_test":"stale-envelope"}\n');

    // Commit the stale envelope so it's tracked in git (it would normally
    // be staged from a previous sign chore commit). We must also commit
    // a new dev commit on top so origin/main sees the stale envelope as
    // a PR-added file.
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'chore: auto-sign attestation for AISDLC-274-old'], root);
    // Move origin/main forward to the baseline (not to include this commit)
    // so git diff origin/main..HEAD shows the stale envelope as PR-added.
    // Actually origin/main already points at the baseline; just add a new dev commit.
    writeFileSync(join(root, 'new-feature.txt'), 'new feature after rebase\n');
    git(['add', 'new-feature.txt'], root);
    git(['commit', '-q', '-m', 'feat: new feature after queue-rebase'], root);
    // HEAD is now the new dev commit. HEAD~1 is the chore commit with the stale envelope.
    const newDevSha = git(['rev-parse', 'HEAD'], root).trim();

    const { cmd } = installFakeSigner(root);
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });

    // Hook must fire (no envelope at new dev HEAD).
    assert.equal(
      r.status,
      1,
      `expected 1 (signed fresh after rebase), got ${r.status}: stderr=${r.stderr}`,
    );
    // Must report stale envelope removal.
    assert.match(r.stderr, /stale envelope/i, `expected stale-envelope message: ${r.stderr}`);

    // Stale envelope must be gone.
    assert.equal(existsSync(staleEnvPath), false, 'stale envelope must be removed before new sign');
    // A new envelope must exist in the attestations directory after the sign cycle.
    // AISDLC-475 Fix B: the fake signer now writes the patch-id-named file (not the
    // SHA-named file), so we check for ANY v6 envelope instead of the specific SHA.
    const newEnvelopes = existsSync(attDir)
      ? readdirSync(attDir).filter((f) => f.endsWith('.v6.dsse.json'))
      : [];
    assert.ok(
      newEnvelopes.length > 0,
      `a new v6 envelope must exist after fresh sign (found: ${newEnvelopes.join(', ')})`,
    );
  });

  // ── AISDLC-475 (Fix B): patch-id idempotency — eliminate re-sign loop ────
  //
  // AC#5 end-to-end: a chore commit on top of a signed dev commit must NOT
  // trigger a re-sign. The patch-id file stays the same across HEAD movements;
  // the pre-push hook keys off patch-id and exits 0 (idempotent).
  //
  // AC#7(a): chore-commit-on-top → NO re-sign.
  // AC#7(b): clean-rebase simulation → NO re-sign.
  // AC#7(c): genuine source change → DOES invalidate + require re-sign (security).

  it('AISDLC-475 AC#7(a): chore-commit-on-top — patch-id envelope already exists → NO re-sign', () => {
    // Scenario: the signer signed a dev commit (wrote <patch-id>.v6.dsse.json),
    // then a chore commit landed on top (moving HEAD to the chore SHA).
    // The hook must see the patch-id envelope and exit 0 without re-signing.
    writeFileSync(join(root, '.active-task'), 'AISDLC-475\n');
    writeVerdictFile(root, 'AISDLC-475');

    // Step 1: write a source file and commit it (this becomes the dev commit).
    writeFileSync(join(root, 'source-475a.ts'), 'export const x = 1;\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: add source file (AISDLC-475-ac7a)'], root);
    const devHead = git(['rev-parse', 'HEAD'], root).trim();

    // Step 2: compute the patch-id the bash hook would compute for this commit.
    // The bash hook uses: git diff-tree origin/main..HEAD -- exclusions | git patch-id --stable
    const mergeBase = execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], {
      cwd: root,
      encoding: 'utf-8',
    }).trim();
    const diffOut = spawnSync(
      'git',
      [
        'diff-tree',
        '--no-color',
        '-p',
        `${mergeBase}..HEAD`,
        '--',
        ':!.ai-sdlc/attestations/',
        ':!.ai-sdlc/transcript-leaves/',
        ':!.ai-sdlc/transcript-leaves.jsonl',
      ],
      { cwd: root, encoding: 'utf-8' },
    );
    const patchIdResult = spawnSync('git', ['patch-id', '--stable'], {
      input: diffOut.stdout,
      cwd: root,
      encoding: 'utf-8',
    });
    const patchId = patchIdResult.stdout.trim().slice(0, 40);
    assert.ok(
      /^[0-9a-f]{40}$/.test(patchId),
      `computed patch-id must be 40-hex, got: "${patchId}"`,
    );

    // Step 3: write the patch-id envelope (simulating the real signer writing it).
    const attDir = join(root, '.ai-sdlc', 'attestations');
    mkdirSync(attDir, { recursive: true });
    const patchIdEnvPath = join(attDir, `${patchId}.v6.dsse.json`);
    writeFileSync(patchIdEnvPath, '{"_test":"patch-id-envelope","schemaVersion":"v6"}\n');

    // Stage and commit the envelope as a chore commit (simulating the chore that
    // moves HEAD past the dev commit — exactly the situation Fix B addresses).
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'chore: auto-sign attestation for AISDLC-475 (AISDLC-133)'], root);
    const choreHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(choreHead, devHead, 'chore commit must advance HEAD');

    // Step 4: run the hook. With Fix B, the hook computes the same patch-id,
    // finds the patch-id envelope, and exits 0 (idempotent — no re-sign).
    const { cmd, logPath } = installFakeSigner(root, { fail: true });
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });

    assert.equal(
      r.status,
      0,
      `AISDLC-475 AC#7(a): hook must exit 0 (idempotent) when patch-id envelope exists, ` +
        `even though HEAD moved past the signed SHA. Got ${r.status}: ${r.stderr}`,
    );
    // Signer must NOT have been invoked.
    assert.equal(
      existsSync(logPath),
      false,
      'AISDLC-475 AC#7(a): signer must NOT be invoked when patch-id envelope is present',
    );
    // No new commit must land.
    const finalHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.equal(finalHead, choreHead, 'HEAD must not change on idempotent skip');
  });

  it('AISDLC-475 AC#7(c) SECURITY: genuine source change invalidates the existing patch-id envelope', () => {
    // This is the security-critical negative test: a real source-file change
    // MUST produce a different patch-id (because the diff changes), which means
    // the old envelope at the pre-change patch-id is NOT found, and the hook
    // MUST re-sign. This guards against Fix B accidentally weakening the trust
    // chain by treating any existing envelope as valid.
    writeFileSync(join(root, '.active-task'), 'AISDLC-475\n');
    writeVerdictFile(root, 'AISDLC-475');

    // Step 1: write initial source file and commit (simulates the dev commit).
    writeFileSync(join(root, 'source-475c.ts'), 'export const y = 1;\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: initial source (AISDLC-475-ac7c)'], root);

    // Step 2: compute patch-id for the INITIAL commit and write a fake envelope.
    const mergeBase1 = execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], {
      cwd: root,
      encoding: 'utf-8',
    }).trim();
    const diffOut1 = spawnSync(
      'git',
      [
        'diff-tree',
        '--no-color',
        '-p',
        `${mergeBase1}..HEAD`,
        '--',
        ':!.ai-sdlc/attestations/',
        ':!.ai-sdlc/transcript-leaves/',
        ':!.ai-sdlc/transcript-leaves.jsonl',
      ],
      { cwd: root, encoding: 'utf-8' },
    );
    const patchIdResult1 = spawnSync('git', ['patch-id', '--stable'], {
      input: diffOut1.stdout,
      cwd: root,
      encoding: 'utf-8',
    });
    const oldPatchId = patchIdResult1.stdout.trim().slice(0, 40);
    assert.ok(
      /^[0-9a-f]{40}$/.test(oldPatchId),
      `initial patch-id must be 40-hex, got: "${oldPatchId}"`,
    );

    // Write the old patch-id envelope.
    const attDir = join(root, '.ai-sdlc', 'attestations');
    mkdirSync(attDir, { recursive: true });
    const oldEnvPath = join(attDir, `${oldPatchId}.v6.dsse.json`);
    writeFileSync(oldEnvPath, '{"_test":"old-patch-id-envelope","schemaVersion":"v6"}\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'chore: auto-sign for initial source'], root);

    // Step 3: make a GENUINE source change (modifying the source file).
    // This changes the diff → different patch-id → old envelope is invalid.
    writeFileSync(join(root, 'source-475c.ts'), 'export const y = 99; // CHANGED\n');
    git(['add', '.'], root);
    git(
      ['commit', '-q', '-m', 'feat: change source (AISDLC-475-ac7c) — MUST invalidate envelope'],
      root,
    );
    const newDevHead = git(['rev-parse', 'HEAD'], root).trim();

    // Step 4: run the hook. With Fix B, the hook computes a NEW patch-id
    // (different from oldPatchId because the diff changed) → no envelope found
    // → MUST sign (re-sign). The old envelope at oldPatchId is NOT treated as valid.
    const { cmd, logPath } = installFakeSigner(root);
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });

    assert.equal(
      r.status,
      1,
      `AISDLC-475 AC#7(c) SECURITY: genuine source change must force a re-sign (exit 1), ` +
        `got ${r.status}: ${r.stderr}`,
    );
    // Signer MUST have been invoked (it's a new content state).
    assert.equal(
      existsSync(logPath),
      true,
      'AISDLC-475 AC#7(c) SECURITY: signer MUST be invoked after a genuine source change',
    );
    // A new commit must have landed (the new chore-sign commit).
    const finalHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(
      finalHead,
      newDevHead,
      'a new chore commit must be added after genuine source change',
    );
  });
});
