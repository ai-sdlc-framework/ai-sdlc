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
  delete env.AI_SDLC_SKIP_ATTESTATION_SIGN;
  delete env.AI_SDLC_SIGN_ATTESTATION_CMD;
  delete env.AI_SDLC_ITERATION_COUNT;
  delete env.AI_SDLC_HARNESS_NOTE;
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
  const writeBlock = silent
    ? '# silent mode: do not write the file'
    : `mkdir -p "$WT_ROOT/.ai-sdlc/attestations"
printf '{"_test":"stub","head":"%s"}\\n' "$HEAD" > "$WT_ROOT/.ai-sdlc/attestations/$HEAD.dsse.json"`;
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

  it('AC #4: idempotent — exits 0 when attestation already exists at HEAD', () => {
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    writeVerdictFile(root, 'AISDLC-133');
    // Simulate a pre-existing attestation at current HEAD.
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const attDir = join(root, '.ai-sdlc', 'attestations');
    mkdirSync(attDir, { recursive: true });
    writeFileSync(join(attDir, `${head}.dsse.json`), '{"existing":true}\n');
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

  it('AC #1+5: signs + commits + exits 1 when sentinel + verdict + no attestation', () => {
    writeFileSync(join(root, '.active-task'), 'AISDLC-133\n');
    writeVerdictFile(root, 'AISDLC-133');
    const head = git(['rev-parse', 'HEAD'], root).trim();

    const { cmd } = installFakeSigner(root);
    const r = runHook(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });

    assert.equal(r.status, 1, `expected 1 (re-push required), got ${r.status}: ${r.stderr}`);
    // Re-push message must be actionable.
    assert.match(r.stderr, /re-run `git push`|re-push required|added an attestation/i);
    // Attestation file must be present at the original HEAD (the signer
    // wrote it BEFORE we made the chore commit, so the binding is to the
    // dev's commit, not the chore).
    const attPath = join(root, '.ai-sdlc', 'attestations', `${head}.dsse.json`);
    assert.equal(existsSync(attPath), true, 'attestation file must exist after sign');
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
});
