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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
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
  // AISDLC-250: don't inherit CODEX_VERSION from the host env so tests that
  // assert the "absent" path are hermetic even when the operator has exported it.
  delete env.CODEX_VERSION;
  // AISDLC-380: existing tests focus on logic other than sub-attestation
  // verification. Use a stub verifier that always exits 0 so the test's
  // verdict files (legacy plain-JSON shape) pass through without signature
  // checking. Tests that specifically test sub-attestation verification
  // unset AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD in their env overrides.
  //
  // AISDLC-380 iter-3: the hook now gates the override on AI_SDLC_TEST_MODE=1
  // so a dev subagent cannot use it to bypass the fail-CLOSED gate. Tests must
  // therefore also set AI_SDLC_TEST_MODE=1 when using the override.
  if (!('AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD' in extra)) {
    env.AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD = 'true';
    env.AI_SDLC_TEST_MODE = '1';
  }
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
  // Synthesize an `origin/main` ref pointing at the baseline so the docs-only
  // predicate can compute `git diff origin/main...HEAD`. The hook fail-CLOSEs
  // when origin/main is unreachable (AISDLC-215 review fix), so tests that
  // simulate dev branches MUST configure this baseline ref.
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], root);
  return root;
}

/**
 * Install a fake signer script at `<root>/bin/fake-signer.sh` that writes a
 * stub attestation file at `.ai-sdlc/attestations/<head-sha>.dsse.json`.
 * Returns an absolute command string suitable for AI_SDLC_SIGN_ATTESTATION_CMD.
 *
 * @param {string} root  worktree root
 * @param {object} opts
 * @param {boolean} [opts.fail=false]    if true, the signer exits non-zero
 *   without writing the file (simulates orchestrator-not-built or signing-key
 *   missing).
 * @param {boolean} [opts.silent=false]  if true, the signer exits 0 but does
 *   NOT write the attestation file (simulates a buggy signer that doesn't
 *   produce its expected output).
 */
function installFakeSigner(root, { fail = false, silent = false } = {}) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(root, 'signer.log');
  const shimPath = join(binDir, 'fake-signer.sh');
  const failBlock = fail ? 'exit 7' : '';
  // RFC-0042 Phase 3: schema-version-aware fake signer.
  // v6 → <sha>.v6.dsse.json; v5 (or anything else) → <sha>.dsse.json.
  const writeBlock = silent
    ? '# silent mode: do not write the file'
    : `mkdir -p "$WT_ROOT/.ai-sdlc/attestations"
SCHEMA_VERSION_ARG="v6"
for arg in "$@"; do
  prev_was_schema_version=0
  if [ "$prev_was_schema" = "1" ]; then SCHEMA_VERSION_ARG="$arg"; break; fi
  if [ "$arg" = "--schema-version" ]; then prev_was_schema=1; fi
done
# Simpler: grep --schema-version arg from $*
if echo "$*" | grep -q -- "--schema-version v5"; then
  SCHEMA_VERSION_ARG="v5"
fi
if [ "$SCHEMA_VERSION_ARG" = "v6" ]; then
  EXT=".v6.dsse.json"
else
  EXT=".dsse.json"
fi
printf '{"_test":"stub","head":"%s","schemaVersion":"%s"}\\n' "$HEAD" "$SCHEMA_VERSION_ARG" > "$WT_ROOT/.ai-sdlc/attestations/$HEAD$EXT"`;
  const shim = `#!/usr/bin/env bash
echo "fake-signer $*" >> "${logPath}"
${failBlock}
WT_ROOT=$(git rev-parse --show-toplevel)
HEAD=$(git rev-parse HEAD)
${writeBlock}
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

  it('AC #4: idempotent — exits 0 when attestation already exists at HEAD (v6 default)', () => {
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    writeVerdictFile(root, 'AISDLC-133');
    // Simulate a pre-existing attestation at current HEAD.
    // RFC-0042 Phase 3: default schema is v6 → file is <sha>.v6.dsse.json.
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const attDir = join(root, '.ai-sdlc', 'attestations');
    mkdirSync(attDir, { recursive: true });
    writeFileSync(join(attDir, `${head}.v6.dsse.json`), '{"existing":true,"schemaVersion":"v6"}\n');
    // Even with a "fail-everything" signer, idempotent skip should NOT invoke it.
    const { cmd, logPath } = installFakeSigner(root, { fail: true });
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
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

    // New envelope at dev2's SHA (RFC-0042 Phase 3: default v6 → .v6.dsse.json).
    const dev2Envelope = join(root, '.ai-sdlc', 'attestations', `${dev2}.v6.dsse.json`);
    assert.equal(existsSync(dev2Envelope), true, 'new v6 envelope must exist at dev2 SHA');

    // New chore commit on top.
    const newHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(newHead, dev2, 'a new chore commit must have been added on top of dev2');
    const newSubject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.match(newSubject, /^chore: auto-sign attestation for AISDLC-135/);

    // Signer was invoked again (log grew).
    const logAfter = execFileSync('cat', [logPath], { encoding: 'utf-8' });
    assert.notEqual(logAfter, logBefore, 'signer must be re-invoked for the brand-new dev commit');
  });

  // ── AISDLC-215: docs-only auto-approve ────────────────────────────────

  it('AISDLC-215: docs-only PR + missing verdicts → auto-signs (no-op second push)', () => {
    // A docs-only commit (README.md change) with an active-task sentinel but
    // no verdict file. The hook must synthesize verdicts and sign, exiting 1
    // with "re-push required". The second push (HEAD is auto-sign chore)
    // must be a no-op per AISDLC-135.
    // NOTE: write .active-task AFTER the docs commit so git diff doesn't
    // include .active-task (in production .active-task is gitignored; the
    // test repo has no .gitignore, so we avoid git-adding it by writing
    // the sentinel after the commit that captures the docs-only files).

    // Add a docs-only commit so HEAD~1...HEAD shows a markdown-only diff.
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\nContent.\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'docs: add guide'], root);

    // Write sentinel AFTER commit so it is not tracked/staged.
    writeFileSync(join(root, '.active-task'), 'AISDLC-215\n');
    // No verdict file written — this is the docs-only path.

    const devHead = git(['rev-parse', 'HEAD'], root).trim();
    const { cmd } = installFakeSigner(root);

    // First push — hook should detect docs-only, synthesize verdicts, sign.
    const r1 = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(
      r1.status,
      1,
      `expected 1 (auto-signed docs-only), got ${r1.status}: ${r1.stderr}`,
    );
    assert.match(r1.stderr, /docs-only changeset detected/i);
    assert.match(r1.stderr, /synthesizing auto-approved verdicts/i);

    // Attestation must exist at dev HEAD.
    // RFC-0042 Phase 3: default v6 → .v6.dsse.json.
    const attPath = join(root, '.ai-sdlc', 'attestations', `${devHead}.v6.dsse.json`);
    assert.equal(existsSync(attPath), true, 'v6 attestation file must exist after auto-sign');

    // A chore commit must have been added.
    const choreHead = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(choreHead, devHead, 'a chore commit must have been added on top of HEAD');
    const choreSubject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.match(choreSubject, /^chore: auto-sign attestation for AISDLC-215/);

    // The synthesized verdict file must mention "auto-approved".
    const verdictPath = join(root, '.ai-sdlc', 'verdicts', 'aisdlc-215.json');
    assert.equal(existsSync(verdictPath), true, 'synthesized verdict file must exist');
    const verdictContent = JSON.parse(execFileSync('cat', [verdictPath], { encoding: 'utf-8' }));
    assert.ok(
      Array.isArray(verdictContent) && verdictContent.length === 3,
      'must have 3 reviewer entries',
    );
    assert.ok(
      verdictContent.every((v) => v.approved === true),
      'all reviewers must be approved=true',
    );
    assert.ok(
      verdictContent.some((v) => /auto-approved/i.test(v.summary)),
      'at least one summary must mention auto-approved',
    );
  });

  it('AISDLC-215: code PR + missing verdicts → no-op (original behavior preserved)', () => {
    // A code commit (src/index.ts change) with an active-task sentinel but
    // no verdict file. The hook must NOT synthesize verdicts — it should exit
    // 0 with "not docs-only — skipping" so code PRs still require real review.
    // NOTE: write .active-task AFTER the commit (see docs-only test above).

    // Add a code commit so HEAD~1...HEAD shows a non-docs file.
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'feat: add index'], root);

    // Write sentinel AFTER commit so it is not tracked/staged.
    writeFileSync(join(root, '.active-task'), 'AISDLC-215\n');
    // No verdict file written — simulates reviewers not having run yet.

    const { cmd, logPath } = installFakeSigner(root);
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });

    assert.equal(
      r.status,
      0,
      `expected 0 (no-op for code PR without verdicts), got ${r.status}: ${r.stderr}`,
    );
    assert.match(r.stderr, /not docs-only — skipping/i);
    // Signer must NOT be invoked.
    assert.equal(
      existsSync(logPath),
      false,
      'signer must NOT run when changeset is not docs-only and verdicts are missing',
    );
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

  // ── AISDLC-380 Bug #2: docs-only post-380 regression ─────────────────────
  //
  // After AISDLC-380 added sub-attestation verification (Step 4d), the
  // synthesized docs-only plain-JSON verdict was being passed to the verifier,
  // which classified it as legacy and refused to sign. The fix sets
  // DOCS_ONLY_SYNTHESIZED=1 so Step 4d is skipped for synthesized verdicts.

  it('AISDLC-380 Bug#2: docs-only PR succeeds after sub-attestation gate added', () => {
    // A docs-only commit with no verdict file. The hook must synthesize verdicts
    // AND skip sub-attestation verification (because docs-only PRs have no
    // reviewer fan-out). The sign step must proceed and exit 1 (re-push).
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'guide2.md'), '# Guide 2\nContent.\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'docs: add guide2'], root);

    writeFileSync(join(root, '.active-task'), 'AISDLC-380B\n');
    // No verdict file — docs-only path.

    // Set up trusted-reviewers.yaml with reviewer entries so the verifier
    // would normally require sub-attestations.
    mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(root, '.ai-sdlc', 'trusted-reviewers.yaml'),
      `# Test\nreviewers:\n  - type: 'reviewer'\n    reviewer: 'code-reviewer'\n    machine: 'testmachine'\n    addedAt: '2026-05-20'\n    addedBy: 'test'\n    pubkey: |\n      -----BEGIN PUBLIC KEY-----\n      MCowBQYDK2VwAyEA7RfNqQjnRnt7dG0gjIWIkqyfvn+/aMycmbaEbq7lS7E=\n      -----END PUBLIC KEY-----\n`,
    );

    // Copy verify script so the hook can find it.
    mkdirSync(join(root, 'scripts'), { recursive: true });
    execFileSync('cp', [
      join(__dirname, 'verify-reviewer-sub-attestations.mjs'),
      join(root, 'scripts', 'verify-reviewer-sub-attestations.mjs'),
    ]);

    // Install the REAL verifier and a registry with reviewer entries, so that
    // if the DOCS_ONLY_SYNTHESIZED bypass fails, the hook would exit 2.
    mkdirSync(join(root, 'scripts'), { recursive: true });
    execFileSync('cp', [
      join(__dirname, 'verify-reviewer-sub-attestations.mjs'),
      join(root, 'scripts', 'verify-reviewer-sub-attestations.mjs'),
    ]);
    mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(root, '.ai-sdlc', 'trusted-reviewers.yaml'),
      `# Test\nreviewers:\n  - type: 'reviewer'\n    reviewer: 'code-reviewer'\n    machine: 'testmachine'\n    addedAt: '2026-05-20'\n    addedBy: 'test'\n    pubkey: |\n      -----BEGIN PUBLIC KEY-----\n      MCowBQYDK2VwAyEA7RfNqQjnRnt7dG0gjIWIkqyfvn+/aMycmbaEbq7lS7E=\n      -----END PUBLIC KEY-----\n`,
    );

    const { cmd } = installFakeSigner(root);
    const r = runHook(root, {
      AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
      // Unset the default stub so the real verifier is used via the file path.
      // This tests that docs-only skips sub-attestation verification via
      // DOCS_ONLY_SYNTHESIZED=1, NOT by having the stub bypass it.
      AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD: '',
    });

    // The hook must succeed (exit 1 = signed + re-push needed, NOT exit 2 = refused).
    assert.equal(
      r.status,
      1,
      `expected exit 1 (docs-only auto-signed), got ${r.status}: stderr=${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /docs-only changeset detected/i,
      `stderr must confirm docs-only: ${r.stderr}`,
    );
    // Must NOT emit sub-attestation verification failure.
    assert.equal(
      r.stderr.includes('sub-attestation verification failed'),
      false,
      `docs-only must NOT hit sub-attestation verification: ${r.stderr}`,
    );
  });

  // ── AISDLC-380 Bug #3: fail-CLOSED when verifier or registry missing (v5 mode) ──
  //
  // RFC-0042 Phase 3 note (AISDLC-383.6): these tests explicitly set
  // AI_SDLC_SCHEMA_VERSION=v5 to exercise the legacy v5 sub-attestation gate.
  // The default is now v6, which skips the gate entirely.

  it('AISDLC-380 Bug#3: v5 mode — exits with warning when verify-reviewer-sub-attestations.mjs is missing (audit-only)', () => {
    // RFC-0042 Phase 3: v5 mode is audit-only. When the verifier script is absent,
    // the hook emits a warning and proceeds to sign (exit 1 = re-push needed).
    // This is a behavioral change from pre-cutover (was: exit 2 = blocked).
    // Use a fresh repo without the verifier script installed.
    const bareRoot = mkdtempSync(join(tmpdir(), 'ai-sdlc-att-bare-'));
    try {
      git(['init', '-q', '-b', 'main'], bareRoot);
      git(['config', 'user.email', 'test@test.com'], bareRoot);
      git(['config', 'user.name', 'test'], bareRoot);
      git(['config', 'commit.gpgsign', 'false'], bareRoot);
      writeFileSync(join(bareRoot, 'README.md'), 'baseline\n');
      git(['add', '.'], bareRoot);
      git(['commit', '-q', '-m', 'baseline'], bareRoot);
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], bareRoot);

      writeFileSync(join(bareRoot, '.active-task'), 'AISDLC-380C\n');

      // Write a verdict file.
      const dir = join(bareRoot, '.ai-sdlc', 'verdicts');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'aisdlc-380c.json'),
        JSON.stringify([
          { agentId: 'code-reviewer', approved: true, findings: [], summary: 'test' },
        ]),
      );

      // Set up trusted-reviewers.yaml but NO verifier script.
      writeFileSync(join(bareRoot, '.ai-sdlc', 'trusted-reviewers.yaml'), 'reviewers:\n');

      const { cmd } = installFakeSigner(bareRoot);
      const r = runHook(bareRoot, {
        AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
        // Explicitly unset the stub so the hook exercises the file-existence check.
        AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD: '',
        // Force v5 mode to exercise the legacy sub-attestation path.
        AI_SDLC_SCHEMA_VERSION: 'v5',
      });

      // RFC-0042 Phase 3: audit-only → hook warns but proceeds to sign (exit 1 = re-push).
      assert.equal(
        r.status,
        1,
        `expected exit 1 (audit-only: verifier missing → warns + proceeds), got ${r.status}: stderr=${r.stderr}`,
      );
      assert.match(
        r.stderr,
        /WARN.*verify-reviewer-sub-attestations\.mjs.*not found|WARN.*sub-attestation gate skipped/i,
        `stderr must show audit-only warning: ${r.stderr}`,
      );
    } finally {
      rmSync(bareRoot, { recursive: true, force: true });
    }
  });

  it('AISDLC-380 Bug#3: v5 mode — exits with warning when .ai-sdlc/trusted-reviewers.yaml is missing (audit-only)', () => {
    // RFC-0042 Phase 3: v5 mode is audit-only. Registry missing → warn + proceed.
    const bareRoot = mkdtempSync(join(tmpdir(), 'ai-sdlc-att-bare2-'));
    try {
      git(['init', '-q', '-b', 'main'], bareRoot);
      git(['config', 'user.email', 'test@test.com'], bareRoot);
      git(['config', 'user.name', 'test'], bareRoot);
      git(['config', 'commit.gpgsign', 'false'], bareRoot);
      writeFileSync(join(bareRoot, 'README.md'), 'baseline\n');
      git(['add', '.'], bareRoot);
      git(['commit', '-q', '-m', 'baseline'], bareRoot);
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], bareRoot);

      writeFileSync(join(bareRoot, '.active-task'), 'AISDLC-380D\n');

      const dir = join(bareRoot, '.ai-sdlc', 'verdicts');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'aisdlc-380d.json'),
        JSON.stringify([
          { agentId: 'code-reviewer', approved: true, findings: [], summary: 'test' },
        ]),
      );

      // Copy verify script but DO NOT write trusted-reviewers.yaml.
      mkdirSync(join(bareRoot, 'scripts'), { recursive: true });
      execFileSync('cp', [
        join(__dirname, 'verify-reviewer-sub-attestations.mjs'),
        join(bareRoot, 'scripts', 'verify-reviewer-sub-attestations.mjs'),
      ]);
      // .ai-sdlc dir exists but no trusted-reviewers.yaml file.
      mkdirSync(join(bareRoot, '.ai-sdlc'), { recursive: true });

      const { cmd } = installFakeSigner(bareRoot);
      const r = runHook(bareRoot, {
        AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
        // Explicitly unset the stub to test the file-existence check path.
        AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD: '',
        // Force v5 mode to exercise the legacy sub-attestation path.
        AI_SDLC_SCHEMA_VERSION: 'v5',
      });

      // RFC-0042 Phase 3: audit-only → hook warns but proceeds to sign (exit 1 = re-push).
      assert.equal(
        r.status,
        1,
        `expected exit 1 (audit-only: registry missing → warns + proceeds), got ${r.status}: stderr=${r.stderr}`,
      );
      assert.match(
        r.stderr,
        /WARN.*trusted-reviewers\.yaml.*not found|WARN.*sub-attestation gate skipped/i,
        `stderr must show audit-only warning: ${r.stderr}`,
      );
    } finally {
      rmSync(bareRoot, { recursive: true, force: true });
    }
  });

  // ── AISDLC-380 iter-3: env-override must require AI_SDLC_TEST_MODE=1 (v5 mode) ──

  it('AISDLC-380 iter-3: v5 mode — AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD without AI_SDLC_TEST_MODE=1 falls through to audit-only file-existence check', () => {
    // In v5 audit-only mode, setting the override without TEST_MODE=1 falls
    // through to the file-existence check, which now warns instead of blocking.
    const bareRoot = mkdtempSync(join(tmpdir(), 'ai-sdlc-att-iter3-'));
    try {
      git(['init', '-q', '-b', 'main'], bareRoot);
      git(['config', 'user.email', 'test@test.com'], bareRoot);
      git(['config', 'user.name', 'test'], bareRoot);
      git(['config', 'commit.gpgsign', 'false'], bareRoot);
      writeFileSync(join(bareRoot, 'README.md'), 'baseline\n');
      git(['add', '.'], bareRoot);
      git(['commit', '-q', '-m', 'baseline'], bareRoot);
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], bareRoot);

      writeFileSync(join(bareRoot, '.active-task'), 'AISDLC-380E\n');

      const dir = join(bareRoot, '.ai-sdlc', 'verdicts');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'aisdlc-380e.json'),
        JSON.stringify([
          { agentId: 'code-reviewer', approved: true, findings: [], summary: 'test' },
        ]),
      );

      // No verifier script, no registry — would-be fail-CLOSED conditions.
      // In v5 audit-only mode: override without TEST_MODE falls through to
      // file-existence check, which now warns + proceeds (not blocks).
      const { cmd } = installFakeSigner(bareRoot);
      const r = runHook(bareRoot, {
        AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
        AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD: 'true',
        // NOTE: AI_SDLC_TEST_MODE intentionally NOT set.
        AI_SDLC_TEST_MODE: '',
        // Force v5 mode to exercise the legacy sub-attestation path.
        AI_SDLC_SCHEMA_VERSION: 'v5',
      });

      // RFC-0042 Phase 3: audit-only → warns and proceeds (exit 1 = re-push needed).
      assert.equal(
        r.status,
        1,
        `expected exit 1 (audit-only: warns + proceeds), got ${r.status}: stderr=${r.stderr}`,
      );
      assert.match(
        r.stderr,
        /WARN.*not found|WARN.*sub-attestation gate skipped/i,
        `stderr must show audit-only warning path: ${r.stderr}`,
      );
    } finally {
      rmSync(bareRoot, { recursive: true, force: true });
    }
  });

  // ── RFC-0042 Phase 3 cutover tests (AISDLC-383.6) ────────────────────────

  it('RFC-0042 Phase 3 (AC #6): v6 mode — skips sub-attestation gate entirely, signs successfully', () => {
    // AC #6: hermetic test covering cutover behavior.
    // v6 is the default (AI_SDLC_SCHEMA_VERSION unset or 'v6').
    // The hook must NOT invoke the sub-attestation verifier at all,
    // even when the verdict file is a legacy plain-JSON shape (no sub-attestations).
    // This specifically tests the case that would have failed pre-cutover.
    writeFileSync(join(root, '.active-task'), 'AISDLC-383F\n');
    // Write a legacy plain-JSON verdict file (no sub-attestations block).
    const dir = join(root, '.ai-sdlc', 'verdicts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'aisdlc-383f.json'),
      JSON.stringify([
        {
          agentId: 'code-reviewer',
          harness: 'claude-code',
          approved: true,
          findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        },
        {
          agentId: 'test-reviewer',
          harness: 'claude-code',
          approved: true,
          findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        },
        {
          agentId: 'security-reviewer',
          harness: 'claude-code',
          approved: true,
          findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        },
      ]),
    );
    const { cmd } = installFakeSigner(root);
    const r = runHook(root, {
      AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
      // Default v6 (no AI_SDLC_SCHEMA_VERSION set, or explicitly v6).
      AI_SDLC_SCHEMA_VERSION: 'v6',
    });

    // v6 mode: gate skipped, sign proceeds, exit 1 = re-push required.
    assert.equal(
      r.status,
      1,
      `expected exit 1 (v6: gate skipped, signed), got ${r.status}: stderr=${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /v6 envelope mode.*AISDLC-380 sub-attestation gate skipped/i,
      `stderr must confirm v6 mode gate skip: ${r.stderr}`,
    );
    // Must NOT emit sub-attestation verification failure.
    assert.equal(
      r.stderr.includes('sub-attestation verification failed'),
      false,
      `v6 mode must NOT invoke sub-attestation verifier: ${r.stderr}`,
    );
  });

  it('RFC-0042 Phase 3 (AC #6): v5 envelope with no sub-attestations — gate runs audit-only, push succeeds (pre-cutover would have blocked)', () => {
    // AC #6: hermetic regression test — the specific cutover behavior.
    // Pre-cutover: a v5 verdict file without sub-attestations would exit 2 (blocked).
    // Post-cutover: same file in v5 audit-only mode → warning + exit 1 (push proceeds).
    const bareRoot = mkdtempSync(join(tmpdir(), 'ai-sdlc-383.6-cutover-'));
    try {
      git(['init', '-q', '-b', 'main'], bareRoot);
      git(['config', 'user.email', 'test@test.com'], bareRoot);
      git(['config', 'user.name', 'test'], bareRoot);
      git(['config', 'commit.gpgsign', 'false'], bareRoot);
      writeFileSync(join(bareRoot, 'README.md'), 'baseline\n');
      git(['add', '.'], bareRoot);
      git(['commit', '-q', '-m', 'baseline'], bareRoot);
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], bareRoot);

      writeFileSync(join(bareRoot, '.active-task'), 'AISDLC-383G\n');

      // Write a LEGACY plain-JSON verdict file (no sub-attestations block).
      // This is exactly the kind of file that would have blocked pre-cutover
      // when the sub-attestation gate was mandatory.
      const dir = join(bareRoot, '.ai-sdlc', 'verdicts');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'aisdlc-383g.json'),
        JSON.stringify([
          {
            agentId: 'code-reviewer',
            harness: 'claude-code',
            approved: true,
            findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
          },
        ]),
      );

      // Install verifier + registry so the hook can run the gate.
      mkdirSync(join(bareRoot, 'scripts'), { recursive: true });
      execFileSync('cp', [
        join(__dirname, 'verify-reviewer-sub-attestations.mjs'),
        join(bareRoot, 'scripts', 'verify-reviewer-sub-attestations.mjs'),
      ]);
      mkdirSync(join(bareRoot, '.ai-sdlc'), { recursive: true });
      writeFileSync(
        join(bareRoot, '.ai-sdlc', 'trusted-reviewers.yaml'),
        `# Test\nreviewers:\n  - type: 'reviewer'\n    reviewer: 'code-reviewer'\n    machine: 'testmachine'\n    addedAt: '2026-05-21'\n    addedBy: 'test'\n    pubkey: |\n      -----BEGIN PUBLIC KEY-----\n      MCowBQYDK2VwAyEA7RfNqQjnRnt7dG0gjIWIkqyfvn+/aMycmbaEbq7lS7E=\n      -----END PUBLIC KEY-----\n`,
      );

      const { cmd } = installFakeSigner(bareRoot);
      const r = runHook(bareRoot, {
        AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
        // Force v5 mode: the legacy path runs the gate (audit-only).
        AI_SDLC_SCHEMA_VERSION: 'v5',
        // Unset the stub verifier so the real verifier runs.
        AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD: '',
      });

      // Post-cutover: gate is audit-only — warning emitted, push proceeds (exit 1 = re-push).
      assert.equal(
        r.status,
        1,
        `expected exit 1 (audit-only: legacy verdict warns + proceeds), got ${r.status}: stderr=${r.stderr}`,
      );
      // Must emit audit-only warning (not a hard failure).
      assert.match(
        r.stderr,
        /WARN.*sub-attestation verification failed.*audit-only|WARN.*push not blocked/i,
        `stderr must confirm audit-only mode: ${r.stderr}`,
      );
      // Must NOT treat it as a hard block.
      assert.equal(
        r.status,
        1,
        'exit code 1 (re-push required for signed chore) confirms push was NOT blocked',
      );
    } finally {
      rmSync(bareRoot, { recursive: true, force: true });
    }
  });

  it('RFC-0042 Phase 3: default schema version is v6 (AI_SDLC_SCHEMA_VERSION unset)', () => {
    // The hook must use v6 by default. Verify by checking that the gate-skip
    // message appears when AI_SDLC_SCHEMA_VERSION is not set.
    writeFileSync(join(root, '.active-task'), 'AISDLC-383H\n');
    writeVerdictFile(root, 'AISDLC-383H');
    const { cmd } = installFakeSigner(root);
    const r = runHook(root, {
      AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
      // AI_SDLC_SCHEMA_VERSION intentionally NOT set (should default to v6).
    });

    assert.equal(
      r.status,
      1,
      `expected exit 1 (v6 default: gate skipped, signed), got ${r.status}: stderr=${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /v6 envelope mode.*AISDLC-380 sub-attestation gate skipped/i,
      `stderr must confirm v6 is the default: ${r.stderr}`,
    );
  });

  // ── AISDLC-274: stale-envelope detection ─────────────────────────────

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
    // New envelope must exist at the dev commit's SHA (the signer writes it).
    // RFC-0042 Phase 3: default v6 → .v6.dsse.json.
    const newEnvPath = join(attDir, `${newDevSha}.v6.dsse.json`);
    assert.equal(existsSync(newEnvPath), true, `new envelope must exist at ${newDevSha}`);
  });
});
