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

  it('AC #1+5 (AISDLC-490 B+): signs + amends current commit + exits 0 (no re-push needed)', () => {
    // AISDLC-490 B+ end-state: instead of creating a new chore commit and exiting 1
    // (requiring a second `git push`), the hook amends the current commit to include
    // the attestation files and exits 0 (push proceeds immediately).
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    writeVerdictFile(root, 'AISDLC-133');
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const commitCountBefore = git(['rev-list', '--count', 'HEAD'], root).trim();

    const { cmd } = installFakeSigner(root);
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });

    // AISDLC-490 B+: exits 0 (no re-push required — amend in place).
    assert.equal(r.status, 0, `expected 0 (B+ amend: push proceeds), got ${r.status}: ${r.stderr}`);
    // Deferral hint must still be actionable.
    assert.match(r.stderr, /AI_SDLC_SKIP_ATTESTATION_SIGN=1/);
    // RFC-0042 Phase 3: default is v6 → attestation file is <sha>.v6.dsse.json.
    // Attestation file must be present (written before amend).
    const attPath = join(root, '.ai-sdlc', 'attestations', `${head}.v6.dsse.json`);
    assert.equal(existsSync(attPath), true, 'v6 attestation file must exist after sign');
    // AC-5(a): commit count must NOT increase (amend, not a new commit).
    const commitCountAfter = git(['rev-list', '--count', 'HEAD'], root).trim();
    assert.equal(
      commitCountAfter,
      commitCountBefore,
      `AISDLC-490 AC-5(a): commit count must stay the same after amend (was ${commitCountBefore}, got ${commitCountAfter})`,
    );
    // AC-5(b): no chore-commit subject in the amended commit.
    const newSubject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.doesNotMatch(
      newSubject,
      /chore: auto-sign attestation/,
      `AISDLC-490 AC-5(b): amended commit subject must NOT be a chore-sign subject: ${newSubject}`,
    );
    // HEAD SHA changed (amend creates a new commit object).
    const newHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(newHead, head, 'amend must produce a new commit object (different SHA)');
  });

  it('AC #5 (AISDLC-490 B+): deferral hint is present in stderr (AI_SDLC_SKIP_ATTESTATION_SIGN=1)', () => {
    // The stderr output must still mention the escape hatch so operators can defer
    // signing when needed (e.g. hand-resign with a different key).
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    writeVerdictFile(root, 'AISDLC-133');
    const { cmd } = installFakeSigner(root);
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(r.status, 0, `expected 0 (B+ exit 0), got ${r.status}: ${r.stderr}`);
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
    // AISDLC-490 B+: exits 0 (amend, not a new chore commit).
    assert.equal(r.status, 0, `expected 0 (B+ amend), got ${r.status}: ${r.stderr}`);
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
    // AISDLC-490 B+: exits 0 (amend).
    assert.equal(r.status, 0, `expected 0 (B+ amend), got ${r.status}: ${r.stderr}`);
    const log = execFileSync('cat', [logPath], { encoding: 'utf-8' });
    assert.match(log, /--iteration-count 2/, `signer log must reflect iteration count: ${log}`);
  });

  it('AISDLC-490 B+ / AISDLC-135: amend approach — second push after amend is idempotent (no re-sign)', () => {
    // AISDLC-490 B+ end-state: the hook no longer creates a chore commit (which
    // was the root of the re-sign loop in pre-AISDLC-475 iterations). Instead it
    // amends HEAD in place. On the second push, the patch-id envelope already
    // exists (it was baked into the amended commit) → idempotent skip → exit 0.
    //
    // This replaces the old AISDLC-135 "second push with HEAD as auto-sign chore
    // is a no-op" test. With B+, the chore-commit detection is no longer the
    // primary guard — the patch-id envelope-exists check is.
    //
    // IMPORTANT: a code commit is required for patch-id computation. Without one,
    // the diff origin/main..HEAD has no source changes → patch-id is empty →
    // idempotency falls back to SHA-based check, which breaks after amend.
    writeFileSync(join(root, '.active-task'), 'AISDLC-135\n');
    writeVerdictFile(root, 'AISDLC-135');

    // Add a code commit so patch-id can be computed.
    writeFileSync(join(root, 'feature-135.ts'), 'export const x = 135;\n');
    git(['add', 'feature-135.ts'], root);
    git(['commit', '-q', '-m', 'feat: add feature-135 for idempotency test'], root);

    const devHead = git(['rev-parse', 'HEAD'], root).trim();
    const commitCountBefore = git(['rev-list', '--count', 'HEAD'], root).trim();
    const { cmd, logPath } = installFakeSigner(root);

    // ── First push (amend path) ───────────────────────────────────
    const r1 = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(
      r1.status,
      0,
      `AISDLC-490 B+: first push must exit 0 (amend), got ${r1.status}: ${r1.stderr}`,
    );

    // HEAD SHA changed (amend creates a new commit object) but commit count stays same.
    const amendedHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(amendedHead, devHead, 'amend must produce a new commit SHA');
    const commitCountAfterFirst = git(['rev-list', '--count', 'HEAD'], root).trim();
    assert.equal(
      commitCountAfterFirst,
      commitCountBefore,
      'amend must NOT add a new commit (commit count stays the same)',
    );

    // The envelope was written (patch-id-named, since there's a real code commit).
    // The fake signer writes <patch-id>.v6.dsse.json; check ANY v6 envelope exists.
    const attDirForIdempotency = join(root, '.ai-sdlc', 'attestations');
    const envelopeFiles = existsSync(attDirForIdempotency)
      ? readdirSync(attDirForIdempotency).filter((f) => f.endsWith('.v6.dsse.json'))
      : [];
    assert.ok(envelopeFiles.length > 0, 'v6 envelope must exist in attestations/ after sign');

    // Snapshot signer-log size before second push.
    const logBefore = execFileSync('cat', [logPath], { encoding: 'utf-8' });
    const commitCountBeforeSecond = git(['rev-list', '--count', 'HEAD'], root).trim();

    // ── Second push (idempotent — envelope already baked into amended commit) ──
    const r2 = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(
      r2.status,
      0,
      `second push must be idempotent (exit 0, no re-sign); got ${r2.status}: ${r2.stderr}`,
    );

    // No new commit or additional amend must occur.
    const commitCountAfterSecond = git(['rev-list', '--count', 'HEAD'], root).trim();
    assert.equal(
      commitCountAfterSecond,
      commitCountBeforeSecond,
      `second push must NOT add or amend any commit (count before=${commitCountBeforeSecond} after=${commitCountAfterSecond})`,
    );
    // Signer was NOT re-invoked.
    const logAfter = execFileSync('cat', [logPath], { encoding: 'utf-8' });
    assert.equal(logAfter, logBefore, 'signer must NOT be invoked on the second (idempotent) push');
  });

  it('AISDLC-490 B+ / AISDLC-135: hook fires on a brand-new dev commit even with prior signed commits in history', () => {
    // AISDLC-490 B+ end-state: dev1 → (amend: dev1+envelope) → dev2 (HEAD).
    // dev2 has a different patch-id → old envelope (for dev1's patch-id) is
    // not found → hook fires and amends dev2 with a new envelope.
    writeFileSync(join(root, '.active-task'), 'AISDLC-135\n');
    writeVerdictFile(root, 'AISDLC-135');

    // ── Build dev1 → (amend with envelope) → dev2 history ─────────
    // Step 1: dev1 — first sign cycle (amend path).
    writeFileSync(join(root, 'feature1.txt'), 'first feature\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: first feature'], root);
    const { cmd, logPath } = installFakeSigner(root);
    const rA = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(
      rA.status,
      0,
      `dev1 sign cycle (B+ amend): expected 0, got ${rA.status}: ${rA.stderr}`,
    );
    // HEAD changed (amend creates new SHA) but commit count stays same.
    const amendedDev1 = git(['rev-parse', 'HEAD'], root).trim();
    const countAfterDev1 = git(['rev-list', '--count', 'HEAD'], root).trim();
    assert.equal(countAfterDev1, '2', 'after dev1 amend: baseline + dev1 = 2 commits');

    // Step 2: dev2 — brand-new dev commit ON TOP of amended dev1.
    writeFileSync(join(root, 'feature2.txt'), 'second feature\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: second feature'], root);
    const dev2 = git(['rev-parse', 'HEAD'], root).trim();
    const commitCountBeforeDev2Sign = git(['rev-list', '--count', 'HEAD'], root).trim();
    const dev2Subject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.match(dev2Subject, /^feat: second feature/);

    // ── Hook must fire for dev2 ────────────────────────────────────
    const logBefore = existsSync(logPath)
      ? execFileSync('cat', [logPath], { encoding: 'utf-8' })
      : '';
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(
      r.status,
      0,
      `hook must fire and exit 0 on brand-new dev commit (B+ amend); got ${r.status}: ${r.stderr}`,
    );

    // A new v6 envelope must have been written for dev2.
    const attDirForDev2 = join(root, '.ai-sdlc', 'attestations');
    const dev2EnvelopeFiles = existsSync(attDirForDev2)
      ? readdirSync(attDirForDev2).filter((f) => f.endsWith('.v6.dsse.json'))
      : [];
    assert.ok(dev2EnvelopeFiles.length > 0, 'a new v6 envelope must exist after dev2 sign cycle');

    // No new commit was added (amend, not new commit).
    const commitCountAfterDev2Sign = git(['rev-list', '--count', 'HEAD'], root).trim();
    assert.equal(
      commitCountAfterDev2Sign,
      commitCountBeforeDev2Sign,
      `dev2 sign (amend) must NOT add a new commit (count ${commitCountBeforeDev2Sign} → ${commitCountAfterDev2Sign})`,
    );

    // HEAD SHA changed (amend).
    const newHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(newHead, dev2, 'amend must produce a new commit SHA');

    // The amended commit subject is still the feat: commit (not a chore).
    const amendedSubject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.match(amendedSubject, /^feat: second feature/);

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
    // AISDLC-490 B+: exits 0 (amend, not chore commit).
    assert.equal(r.status, 0, `expected 0 (B+ amend), got ${r.status}: ${r.stderr}`);
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
    // AISDLC-490 B+: exits 0 (amend, not chore commit).
    assert.equal(r.status, 0, `expected 0 (B+ amend), got ${r.status}: ${r.stderr}`);
    const log = execFileSync('cat', [logPath], { encoding: 'utf-8' });
    assert.equal(
      log.includes('--harness-name'),
      false,
      `signer must NOT receive --harness-name when CODEX_VERSION is unset: ${log}`,
    );
  });

  it('AISDLC-490 B+: no chore commit is created (AISDLC-88 CI-skip concern eliminated)', () => {
    // AISDLC-490 B+ end-state: no chore commit is created at all. The attestation
    // is baked into the dev commit via amend. The CI-skip token concern from
    // AISDLC-88 is structurally eliminated — there is no separate commit body to
    // worry about. We verify that the amended commit subject is unchanged from the
    // baseline (not a chore: auto-sign message).
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    writeVerdictFile(root, 'AISDLC-133');
    const originalSubject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    const { cmd } = installFakeSigner(root);
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(r.status, 0, `expected 0 (B+ amend), got ${r.status}: ${r.stderr}`);
    // The amended commit must NOT have a chore: auto-sign subject.
    const amendedSubject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.doesNotMatch(
      amendedSubject,
      /chore: auto-sign attestation/,
      `amended commit must not have a chore-sign subject (B+ invariant): ${amendedSubject}`,
    );
    // The amended commit subject must match the original (amend preserves it).
    assert.equal(
      amendedSubject,
      originalSubject,
      `amended commit subject must be unchanged from original: expected "${originalSubject}", got "${amendedSubject}"`,
    );
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

    // AISDLC-490 B+: exits 0 (amend, not chore commit).
    assert.equal(
      r.status,
      0,
      `expected exit 0 (v6 default: signed + amend), got ${r.status}: stderr=${r.stderr}`,
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

  it('AISDLC-471 / AISDLC-490 B+: amend includes per-patch-id transcript-leaves file when signer writes it', () => {
    // AISDLC-490 B+ end-state: the attestation files (envelope + per-patch-id
    // leaves) are staged into the dev commit via `git commit --amend --no-edit`
    // instead of a new chore commit. The hook exits 0 (no re-push needed).
    writeFileSync(join(root, '.active-task'), 'AISDLC-471\n');
    writeVerdictFile(root, 'AISDLC-471');
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const commitCountBefore = git(['rev-list', '--count', 'HEAD'], root).trim();

    const { cmd } = installFakeSigner(root, { withLeaves: true });
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });

    // AISDLC-490 B+: exits 0 (amend, no re-push needed).
    assert.equal(r.status, 0, `expected 0 (B+ amend), got ${r.status}: ${r.stderr}`);

    // Commit count must stay the same (amend, not new commit).
    const commitCountAfter = git(['rev-list', '--count', 'HEAD'], root).trim();
    assert.equal(
      commitCountAfter,
      commitCountBefore,
      `amend must NOT add a new commit (count before=${commitCountBefore} after=${commitCountAfter})`,
    );

    // AC #1: envelope must be in the amended commit tree.
    const envelopeInTree = spawnSync(
      'git',
      ['ls-tree', 'HEAD', '--', `.ai-sdlc/attestations/${head}.v6.dsse.json`],
      { cwd: root, encoding: 'utf-8' },
    );
    assert.ok(
      envelopeInTree.stdout.trim().length > 0,
      `envelope must be in amended commit tree: git ls-tree output was empty (stderr: ${envelopeInTree.stderr})`,
    );

    // AC #2 (load-bearing for AISDLC-471): per-patch-id leaves file must be in amended commit.
    const leavesInTree = spawnSync(
      'git',
      ['ls-tree', 'HEAD', '--', `.ai-sdlc/transcript-leaves/${head}.jsonl`],
      { cwd: root, encoding: 'utf-8' },
    );
    assert.ok(
      leavesInTree.stdout.trim().length > 0,
      `per-patch-id leaves file must be in amended commit alongside the envelope — ` +
        `this is the AC #2 regression guard for AISDLC-471. ` +
        `git ls-tree output was empty (stderr: ${leavesInTree.stderr})`,
    );
  });

  it('AISDLC-471 / AISDLC-490 B+: backward-compat — hook still works when signer writes no leaves file', () => {
    // When the signer does not emit per-patch-id leaves (e.g. ad-hoc operator
    // signing, or a caller that has not yet wired cli-attestation.mjs emit-leaf),
    // the hook must still succeed: just amends the envelope without the leaves
    // file. `git add` of a non-existent/empty directory is a no-op.
    writeFileSync(join(root, '.active-task'), 'AISDLC-471\n');
    writeVerdictFile(root, 'AISDLC-471');
    const head = git(['rev-parse', 'HEAD'], root).trim();

    // withLeaves: false → signer does NOT write .ai-sdlc/transcript-leaves/
    const { cmd } = installFakeSigner(root, { withLeaves: false });
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });

    // AISDLC-490 B+: exits 0 (amend, no re-push needed).
    assert.equal(r.status, 0, `expected 0 (B+ amend, no leaves), got ${r.status}: ${r.stderr}`);

    // Envelope must be in the amended commit tree.
    const envelopeInTree = spawnSync(
      'git',
      ['ls-tree', 'HEAD', '--', `.ai-sdlc/attestations/${head}.v6.dsse.json`],
      { cwd: root, encoding: 'utf-8' },
    );
    assert.ok(
      envelopeInTree.stdout.trim().length > 0,
      `envelope must be in amended commit even when no leaves file exists: ${envelopeInTree.stderr}`,
    );

    // No leaves file must appear in the amended commit tree.
    const leavesInTree = spawnSync(
      'git',
      ['ls-tree', 'HEAD', '--', `.ai-sdlc/transcript-leaves/${head}.jsonl`],
      { cwd: root, encoding: 'utf-8' },
    );
    assert.equal(
      leavesInTree.stdout.trim(),
      '',
      'no leaves file should appear in amended commit tree when none was written by the signer',
    );
  });

  it('AISDLC-490 B+: amend path commits per-patch-id leaves (primary path — exits 0)', () => {
    // AISDLC-490 B+ replaces the old AISDLC-472 "standalone exit-1 path" with an
    // "amend + exit 0" path. This test guards the load-bearing AISDLC-471 staging
    // behavior: envelope + per-patch-id leaves are staged into the amended commit,
    // and the hook exits 0 (push proceeds immediately, no second `git push` needed).
    writeFileSync(join(root, '.active-task'), 'AISDLC-490-test\n');
    writeVerdictFile(root, 'AISDLC-490-test');
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const commitCountBefore = git(['rev-list', '--count', 'HEAD'], root).trim();

    const { cmd } = installFakeSigner(root, { withLeaves: true });
    // No AI_SDLC_INTERNAL_NO_EXIT_1 — B+ exits 0 in both standalone and orchestrator mode.
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });

    // B+ exits 0 always (amend, push proceeds immediately).
    assert.equal(r.status, 0, `expected 0 (B+ amend exit 0), got ${r.status}: ${r.stderr}`);

    // Commit count must stay the same (amend, not new commit).
    const commitCountAfter = git(['rev-list', '--count', 'HEAD'], root).trim();
    assert.equal(
      commitCountAfter,
      commitCountBefore,
      `B+ amend must NOT add a new commit (count before=${commitCountBefore} after=${commitCountAfter})`,
    );

    // AISDLC-490 AC-5(a): single-commit push shape — commit count unchanged.
    // (checked above)

    // AISDLC-490 AC-5(b): no chore-commit subject in the amended commit.
    const amendedSubject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.doesNotMatch(
      amendedSubject,
      /chore: auto-sign attestation/,
      `AISDLC-490 AC-5(b): no chore-sign subject must appear after B+ amend: ${amendedSubject}`,
    );

    // Envelope must be in the amended commit tree.
    const envelopeInTree = spawnSync(
      'git',
      ['ls-tree', 'HEAD', '--', `.ai-sdlc/attestations/${head}.v6.dsse.json`],
      { cwd: root, encoding: 'utf-8' },
    );
    assert.ok(
      envelopeInTree.stdout.trim().length > 0,
      `envelope must be in amended commit tree: ${envelopeInTree.stderr}`,
    );

    // Load-bearing AISDLC-471 guard: per-patch-id leaves file must be in amended commit.
    const leavesInTree = spawnSync(
      'git',
      ['ls-tree', 'HEAD', '--', `.ai-sdlc/transcript-leaves/${head}.jsonl`],
      { cwd: root, encoding: 'utf-8' },
    );
    assert.ok(
      leavesInTree.stdout.trim().length > 0,
      `per-patch-id leaves must be in amended commit (AISDLC-490 B+ / AISDLC-471): ${leavesInTree.stderr}`,
    );

    // HEAD SHA changed (amend creates new commit object).
    const newHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(newHead, head, 'amend must produce a new commit SHA');
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

    // AISDLC-490 B+: hook fires (no envelope for new dev HEAD's patch-id),
    // removes stale envelope, amends, and exits 0.
    assert.equal(
      r.status,
      0,
      `AISDLC-490 B+: expected 0 (amend after stale-envelope removal + fresh sign), got ${r.status}: stderr=${r.stderr}`,
    );
    // Must report stale envelope removal.
    assert.match(r.stderr, /stale envelope/i, `expected stale-envelope message: ${r.stderr}`);

    // Stale envelope must be gone.
    assert.equal(existsSync(staleEnvPath), false, 'stale envelope must be removed before new sign');
    // A new envelope must exist in the attestations directory after the sign cycle.
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
    // Capture commit count right before the hook fires on the new dev commit.
    const commitCountBeforeHook = git(['rev-list', '--count', 'HEAD'], root).trim();

    // Step 4: run the hook. The hook computes a NEW patch-id
    // (different from oldPatchId because the diff changed) → no envelope found
    // → MUST sign (amend with new envelope). The old envelope at oldPatchId is NOT treated as valid.
    // AISDLC-490 B+: exits 0 (amend in place, not a new chore commit).
    const { cmd, logPath } = installFakeSigner(root);
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });

    assert.equal(
      r.status,
      0,
      `AISDLC-475 AC#7(c) / AISDLC-490 AC-5(c) SECURITY: genuine source change must force ` +
        `a re-sign and exit 0 (amend), got ${r.status}: ${r.stderr}`,
    );
    // Signer MUST have been invoked (it's a new content state).
    assert.equal(
      existsSync(logPath),
      true,
      'AISDLC-490 AC-5(c) SECURITY: signer MUST be invoked after a genuine source change',
    );
    // HEAD SHA must change (amend creates new commit object).
    const finalHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(
      finalHead,
      newDevHead,
      'AISDLC-490 AC-5(c): amend after genuine source change must produce a new commit SHA',
    );
    // CRITICAL AC-5(c): commit count must stay the same (amend, NOT a new commit).
    // If this assertion fails, a genuine source change caused a chore-commit (pre-B+ behavior)
    // which means the re-sign loop is NOT structurally eliminated.
    const commitCountAfter = git(['rev-list', '--count', 'HEAD'], root).trim();
    assert.equal(
      commitCountAfter,
      commitCountBeforeHook,
      `AISDLC-490 AC-5(c): commit count must NOT increase after amend (was ${commitCountBeforeHook}, got ${commitCountAfter})`,
    );
  });

  it('AISDLC-490 AC-5(c) SECURITY — replay guard: B+ amend does NOT allow old envelope to pass on source change', () => {
    // This is the critical AC-5(c) test for B+: a genuine source change MUST produce
    // a different patch-id, making the old envelope at the old patch-id invalid.
    // The hook must re-sign (amend with new envelope). If the old envelope were
    // accepted, that would be a critical trust-chain hole.
    //
    // STOP condition: if the hook exits 0 WITHOUT invoking the signer on a genuine
    // source change, that means the old envelope was treated as valid → CRITICAL
    // security regression. This test guards against that.
    writeFileSync(join(root, '.active-task'), 'AISDLC-490-replay\n');
    writeVerdictFile(root, 'AISDLC-490-replay');

    // Step 1: commit initial source, write envelope at patch-id-1.
    writeFileSync(join(root, 'source-replay-guard.ts'), 'export const v = 1;\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: initial source for replay guard test'], root);

    // Compute patch-id-1.
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
    const patchId1 = patchIdResult.stdout.trim().slice(0, 40);
    assert.ok(/^[0-9a-f]{40}$/.test(patchId1), `patchId1 must be 40-hex, got: "${patchId1}"`);

    // Bake envelope for patch-id-1 into the commit (simulates a prior successful sign).
    const attDir = join(root, '.ai-sdlc', 'attestations');
    mkdirSync(attDir, { recursive: true });
    writeFileSync(
      join(attDir, `${patchId1}.v6.dsse.json`),
      '{"_test":"old-envelope","schemaVersion":"v6"}\n',
    );
    git(['add', '.'], root);
    git(['commit', '--amend', '--no-edit', '-q'], root);

    // Step 2: make a GENUINE source change on top.
    writeFileSync(join(root, 'source-replay-guard.ts'), 'export const v = 999; // CHANGED\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: source change — must invalidate patch-id-1 envelope'], root);
    const devHead2 = git(['rev-parse', 'HEAD'], root).trim();

    // Step 3: run the hook.
    // CRITICAL: the hook must NOT short-circuit on the old patchId1 envelope.
    // It must compute the new patch-id (patchId2), find no envelope there,
    // invoke the signer, and amend with the new envelope.
    const { cmd: signerCmd, logPath } = installFakeSigner(root);
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: signerCmd });

    // CRITICAL: exits 0 (amend).
    assert.equal(
      r.status,
      0,
      `AISDLC-490 AC-5(c): genuine source change must trigger re-sign (exit 0 after amend), got ${r.status}: ${r.stderr}`,
    );
    // CRITICAL: signer MUST have been invoked — old envelope is NOT valid for new patch-id.
    assert.equal(
      existsSync(logPath),
      true,
      `AISDLC-490 AC-5(c) SECURITY CRITICAL: signer MUST be invoked after genuine source change. ` +
        `If the signer was NOT invoked, the old envelope at patchId1 was accepted for new source content — ` +
        `this is a trust-chain hole!`,
    );
    // HEAD SHA must change (amend).
    const newHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(newHead, devHead2, 'amend must produce a new commit SHA');
    // No new commit (amend, not new chore commit).
    // Commit count: baseline(1) + source-change-dev1(2) + source-change-dev2(3) = 3
    // The amend of dev1 and dev2 do NOT increase the count.
    const commitCount = git(['rev-list', '--count', 'HEAD'], root).trim();
    assert.equal(
      commitCount,
      '3',
      `expected 3 commits (baseline + dev1 + dev2 = 3, amends don't add), got ${commitCount}`,
    );
  });
});
