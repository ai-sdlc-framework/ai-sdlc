/**
 * e2e tests for `sign-attestation.mjs` — the helper backing `/ai-sdlc execute`
 * Step 10 (AISDLC-74). Mirrors the `init-signing-key.test.mjs` style: spawn
 * the script under a tmpdir HOME + tmpdir cwd, assert behavior on file
 * existence, error messages, and arg parsing.
 *
 * Run with: node --test ai-sdlc-plugin/scripts/sign-attestation.test.mjs
 */

import { describe, it, beforeEach, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = join(__dirname, 'sign-attestation.mjs');
const repoRoot = join(__dirname, '..', '..');

before(() => {
  // The helper imports the orchestrator's compiled barrel — make sure
  // it's built so the dynamic import resolves.
  try {
    execFileSync('pnpm', ['--filter', '@ai-sdlc/orchestrator', 'build'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch (err) {
    throw new Error(`failed to build orchestrator: ${err.stderr?.toString() ?? err.message}`);
  }
});

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

function setupRepo(tmpHome) {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-sign-test-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  // Required files for sign-attestation.mjs to read.
  mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
  mkdirSync(join(root, 'ai-sdlc-plugin', 'agents'), { recursive: true });
  writeFileSync(join(root, '.ai-sdlc', 'review-policy.md'), '# review policy v1\n');
  writeFileSync(
    join(root, 'ai-sdlc-plugin', 'agents', 'code-reviewer.md'),
    '---\nname: code-reviewer\n---\nbody\n',
  );
  writeFileSync(
    join(root, 'ai-sdlc-plugin', 'agents', 'test-reviewer.md'),
    '---\nname: test-reviewer\n---\nbody\n',
  );
  writeFileSync(
    join(root, 'ai-sdlc-plugin', 'agents', 'security-reviewer.md'),
    '---\nname: security-reviewer\n---\nbody\n',
  );
  writeFileSync(join(root, 'ai-sdlc-plugin', 'plugin.json'), JSON.stringify({ version: '0.7.0' }));
  // Symlink/copy the orchestrator dist (the helper does an absolute path
  // import from `process.cwd()`, so we need the dist available there).
  mkdirSync(join(root, 'orchestrator', 'dist', 'runtime'), { recursive: true });
  // Just copy by re-exporting — easier than symlink across platforms.
  const orchDist = join(repoRoot, 'orchestrator', 'dist', 'runtime', 'attestations.js');
  writeFileSync(
    join(root, 'orchestrator', 'dist', 'runtime', 'attestations.js'),
    `export * from '${orchDist.replace(/\\/g, '\\\\')}';\n`,
  );
  // Initial commit, then HEAD commit.
  writeFileSync(join(root, 'baseline.txt'), 'baseline\n');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'baseline'], root);
  // Create an `origin/main` ref so `git diff origin/main...HEAD` works.
  git(['branch', '-f', 'origin/main', 'HEAD'], root);
  // Add a feature commit.
  writeFileSync(join(root, 'feature.txt'), 'feature\n');
  git(['add', 'feature.txt'], root);
  git(['commit', '-q', '-m', 'feature'], root);
  // Manually point a refs/remotes/origin/main ref so `origin/main` resolves.
  // Easier: configure a fake refspec via update-ref.
  const headSha = git(['rev-parse', 'HEAD'], root).trim();
  const baseSha = git(['rev-parse', 'HEAD~1'], root).trim();
  // refs/remotes/origin/main must point at baseSha for the diff to be
  // exactly the feature commit.
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', baseSha], {
    cwd: root,
    env: cleanEnv(),
  });
  return { root, headSha, baseSha };
}

function writeKey(tmpHome) {
  // Generate a real key into tmpHome via the orchestrator runtime so we
  // don't shell out to init-signing-key.mjs (which would also test env).
  // Easier: just use openssl... actually, easiest is to call generateKeyPairSync
  // via Node directly here in the test.
  mkdirSync(join(tmpHome, '.ai-sdlc'), { recursive: true });
  // Use Node inline to generate.
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      `const {generateKeyPairSync}=require('node:crypto');const {writeFileSync}=require('node:fs');const k=generateKeyPairSync('ed25519');writeFileSync(process.argv[1], k.privateKey.export({format:'pem',type:'pkcs8'}));`,
      join(tmpHome, '.ai-sdlc', 'signing-key.pem'),
    ],
    { encoding: 'utf-8' },
  );
  void out;
}

function runHelper(cwd, args, extraEnv = {}) {
  return spawnSync(process.execPath, [helperPath, ...args], {
    cwd,
    env: cleanEnv(extraEnv),
    encoding: 'utf-8',
  });
}

describe('sign-attestation.mjs', () => {
  let fixture;
  let tmpHome;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ai-sdlc-sign-home-'));
    fixture = setupRepo(tmpHome);
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('errors clearly when --review-verdicts is missing', () => {
    const res = runHelper(fixture.root, [], { HOME: tmpHome });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /--review-verdicts <path> required/);
  });

  it('errors clearly when --iteration-count is invalid', () => {
    const verdictsPath = join(fixture.root, 'verdicts.json');
    writeFileSync(verdictsPath, '[]');
    const res = runHelper(
      fixture.root,
      ['--review-verdicts', verdictsPath, '--iteration-count', 'oops'],
      { HOME: tmpHome },
    );
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /--iteration-count must be a positive integer/);
  });

  it('errors clearly when ~/.ai-sdlc/signing-key.pem is missing', () => {
    // No writeKey call — HOME has no signing-key.
    const verdictsPath = join(fixture.root, 'verdicts.json');
    writeFileSync(
      verdictsPath,
      JSON.stringify([{ agentId: 'code-reviewer', harness: 'codex', approved: true }]),
    );
    const res = runHelper(
      fixture.root,
      ['--review-verdicts', verdictsPath, '--iteration-count', '1'],
      { HOME: tmpHome },
    );
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /No signing key at .*signing-key\.pem/);
    assert.match(res.stderr, /init-signing-key/);
  });

  it('writes a DSSE envelope to .ai-sdlc/attestations/<head-sha>.dsse.json on success', () => {
    writeKey(tmpHome);
    const verdictsPath = join(fixture.root, 'verdicts.json');
    writeFileSync(
      verdictsPath,
      JSON.stringify([
        {
          agentId: 'code-reviewer',
          harness: 'codex',
          approved: true,
          findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        },
        {
          agentId: 'test-reviewer',
          harness: 'codex',
          approved: true,
          findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        },
        {
          agentId: 'security-reviewer',
          harness: 'codex',
          approved: true,
          findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        },
      ]),
    );
    const res = runHelper(
      fixture.root,
      ['--review-verdicts', verdictsPath, '--iteration-count', '1', '--harness-note', ''],
      { HOME: tmpHome, GIT_AUTHOR_EMAIL: 'dev@example.com' },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);
    const expectedPath = join(
      fixture.root,
      '.ai-sdlc',
      'attestations',
      `${fixture.headSha}.dsse.json`,
    );
    assert.ok(existsSync(expectedPath), `expected envelope at ${expectedPath}`);
    assert.ok(res.stdout.includes(expectedPath), 'stdout should print the written path');
  });

  // ── AISDLC-102: --print-content-hash oracle mode ──────────────────
  // Step 10.5 of the orchestrator calls this mode before and after a
  // pre-sign rebase to decide whether reviewers must re-run.

  it('--print-content-hash prints contentHash and exits 0 without writing files (AISDLC-102)', () => {
    // No --review-verdicts, no signing key required — pure read-only.
    const res = runHelper(fixture.root, ['--print-content-hash'], { HOME: tmpHome });
    assert.equal(res.status, 0, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);
    // contentHash from AISDLC-94 is 64-hex-char sha256.
    assert.match(res.stdout.trim(), /^[a-f0-9]{64}$/, 'should print sha256 hex');
    // No envelope must have been written.
    const attestationsDir = join(fixture.root, '.ai-sdlc', 'attestations');
    assert.ok(!existsSync(attestationsDir), 'must not write any attestations files');
  });

  it('--print-content-hash is deterministic across invocations on same content (AISDLC-102)', () => {
    // The AISDLC-94 contentHash binds to {path, blobSha} pairs sorted by
    // path — same files at same SHAs ⇒ same hash. This is the property
    // Step 10.5 relies on to decide "rebase didn't change anything."
    const res1 = runHelper(fixture.root, ['--print-content-hash'], { HOME: tmpHome });
    const res2 = runHelper(fixture.root, ['--print-content-hash'], { HOME: tmpHome });
    assert.equal(res1.status, 0, `res1 stderr: ${res1.stderr}`);
    assert.equal(res2.status, 0, `res2 stderr: ${res2.stderr}`);
    assert.equal(
      res1.stdout.trim(),
      res2.stdout.trim(),
      'two consecutive invocations on identical content must produce identical hash',
    );
  });

  it('--print-content-hash detects content changes (AISDLC-102 re-review oracle)', () => {
    // The ORACLE: if contentHash changes after rebase, reviewers must
    // re-run. Simulate the file-content change case directly by mutating
    // the changed file and amending the commit, then re-hashing.
    const before = runHelper(fixture.root, ['--print-content-hash'], { HOME: tmpHome });
    assert.equal(before.status, 0);
    const beforeHash = before.stdout.trim();

    // Mutate the changed file and amend the HEAD commit so origin/main...HEAD
    // diff now covers different content. fixture.headSha points at the prior
    // HEAD; the amend replaces it.
    writeFileSync(join(fixture.root, 'feature.txt'), 'feature MUTATED\n');
    git(['add', 'feature.txt'], fixture.root);
    git(['commit', '-q', '--amend', '--no-edit'], fixture.root);

    const after = runHelper(fixture.root, ['--print-content-hash'], { HOME: tmpHome });
    assert.equal(after.status, 0);
    const afterHash = after.stdout.trim();
    assert.notEqual(
      beforeHash,
      afterHash,
      'mutating a changed file must change contentHash (re-review trigger)',
    );
  });

  it('emits a v3-only envelope (contentHashV3 required, diffHash + contentHash forbidden) (AISDLC-103)', () => {
    // The local sign script now feeds only collectChangedFileDeltaEntries
    // into buildPredicate. A fresh envelope MUST carry contentHashV3 and
    // MUST NOT carry the legacy diffHash / contentHash fields — the
    // verifier rejects predicates carrying either.
    writeKey(tmpHome);
    const verdictsPath = join(fixture.root, 'verdicts.json');
    writeFileSync(
      verdictsPath,
      JSON.stringify([
        { agentId: 'code-reviewer', harness: 'codex', approved: true, findings: {} },
        { agentId: 'test-reviewer', harness: 'codex', approved: true, findings: {} },
        { agentId: 'security-reviewer', harness: 'codex', approved: true, findings: {} },
      ]),
    );
    const res = runHelper(
      fixture.root,
      ['--review-verdicts', verdictsPath, '--iteration-count', '1', '--harness-note', ''],
      { HOME: tmpHome, GIT_AUTHOR_EMAIL: 'dev@example.com' },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);
    const envPath = join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.dsse.json`);
    const envelope = JSON.parse(readFileSync(envPath, 'utf-8'));
    const predicate = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8'));
    assert.equal(predicate.schemaVersion, 'v3', 'fresh envelope must be schemaVersion v3');
    assert.match(
      predicate.contentHashV3,
      /^[0-9a-f]{64}$/,
      'envelope must carry contentHashV3 (v3, AISDLC-101 / AISDLC-103)',
    );
    assert.equal(
      predicate.diffHash,
      undefined,
      'AISDLC-103: v3 envelope must NOT carry legacy diffHash field',
    );
    assert.equal(
      predicate.contentHash,
      undefined,
      'AISDLC-103: v3 envelope must NOT carry legacy contentHash field',
    );
  });

  // ── AISDLC-355 CRITICAL: findings array vs counts-object shape ───────────
  //
  // Three shapes must all produce correct per-severity counts in the predicate:
  //   1. Flat array with findings:[{severity,message},...] (new resume-from-draft shape)
  //   2. Nested {taskId, decision, verdicts:[{findings:[...]}]} (VerdictFilePayload)
  //   3. Legacy counts-object findings:{critical:N, major:N,...}

  it('AISDLC-355: flat-array findings produce correct per-severity counts in the predicate', () => {
    writeKey(tmpHome);
    const verdictsPath = join(fixture.root, 'verdicts.json');
    // Flat array with findings as ReviewerFinding[] — the shape resume-from-draft writes.
    writeFileSync(
      verdictsPath,
      JSON.stringify([
        {
          agentId: 'code-reviewer',
          harness: 'claude-code',
          approved: false,
          findings: [
            { severity: 'critical', message: 'null dereference' },
            { severity: 'major', message: 'missing auth check' },
            { severity: 'major', message: 'missing input validation' },
            { severity: 'minor', message: 'add a test' },
          ],
        },
        {
          agentId: 'test-reviewer',
          harness: 'claude-code',
          approved: true,
          findings: [{ severity: 'suggestion', message: 'rename variable' }],
        },
        {
          agentId: 'security-reviewer',
          harness: 'claude-code',
          approved: true,
          findings: [],
        },
      ]),
    );
    const res = runHelper(
      fixture.root,
      ['--review-verdicts', verdictsPath, '--iteration-count', '1', '--harness-note', ''],
      { HOME: tmpHome, GIT_AUTHOR_EMAIL: 'dev@example.com' },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);
    const envPath = join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.dsse.json`);
    const envelope = JSON.parse(readFileSync(envPath, 'utf-8'));
    const predicate = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8'));

    // code-reviewer: 1 critical, 2 major, 1 minor
    const codeReviewer = predicate.reviewers.find((r) => r.agentId === 'code-reviewer');
    assert.ok(codeReviewer, 'code-reviewer must appear in predicate reviewers');
    assert.equal(codeReviewer.findings.critical, 1, 'code-reviewer critical count');
    assert.equal(codeReviewer.findings.major, 2, 'code-reviewer major count');
    assert.equal(codeReviewer.findings.minor, 1, 'code-reviewer minor count');
    assert.equal(codeReviewer.findings.suggestion, 0, 'code-reviewer suggestion count');

    // test-reviewer: 1 suggestion
    const testReviewer = predicate.reviewers.find((r) => r.agentId === 'test-reviewer');
    assert.ok(testReviewer, 'test-reviewer must appear in predicate reviewers');
    assert.equal(testReviewer.findings.critical, 0, 'test-reviewer critical count');
    assert.equal(testReviewer.findings.suggestion, 1, 'test-reviewer suggestion count');

    // Branch must still be main after signing (AISDLC-355 minor: AC2 main+dirty)
    const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], fixture.root).trim();
    assert.equal(currentBranch, 'main', 'signing must not change the current branch');
  });

  it('AISDLC-355: nested {taskId, decision, verdicts:[]} shape with findings-array produces correct counts', () => {
    writeKey(tmpHome);
    const verdictsPath = join(fixture.root, 'verdicts.json');
    // Nested VerdictFilePayload shape — what writeVerdictFile in execute.ts writes.
    writeFileSync(
      verdictsPath,
      JSON.stringify({
        taskId: 'AISDLC-355',
        decision: 'CHANGES_REQUESTED',
        approved: false,
        iteration: 1,
        counts: { critical: 1, major: 1, minor: 0, suggestion: 0 },
        harnessNote: '',
        summary: 'CHANGES_REQUESTED',
        verdicts: [
          {
            agentId: 'code-reviewer',
            harness: 'claude-code',
            approved: false,
            findings: [
              { severity: 'critical', message: 'use-after-free' },
              { severity: 'major', message: 'off by one' },
            ],
          },
          {
            agentId: 'test-reviewer',
            harness: 'claude-code',
            approved: true,
            findings: [],
          },
          {
            agentId: 'security-reviewer',
            harness: 'claude-code',
            approved: true,
            findings: [],
          },
        ],
      }),
    );
    const res = runHelper(
      fixture.root,
      ['--review-verdicts', verdictsPath, '--iteration-count', '1', '--harness-note', ''],
      { HOME: tmpHome, GIT_AUTHOR_EMAIL: 'dev@example.com' },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);
    const envPath = join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.dsse.json`);
    const envelope = JSON.parse(readFileSync(envPath, 'utf-8'));
    const predicate = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8'));

    const codeReviewer = predicate.reviewers.find((r) => r.agentId === 'code-reviewer');
    assert.ok(codeReviewer, 'code-reviewer must appear in predicate reviewers');
    assert.equal(
      codeReviewer.findings.critical,
      1,
      'code-reviewer critical count from nested shape',
    );
    assert.equal(codeReviewer.findings.major, 1, 'code-reviewer major count from nested shape');
  });

  it('AISDLC-355: legacy counts-object findings:{critical:N,...} shape still produces correct counts (backward compat)', () => {
    writeKey(tmpHome);
    const verdictsPath = join(fixture.root, 'verdicts.json');
    // Legacy counts-object shape — pre-AISDLC-355 verdict files.
    writeFileSync(
      verdictsPath,
      JSON.stringify([
        {
          agentId: 'code-reviewer',
          harness: 'codex',
          approved: false,
          findings: { critical: 2, major: 3, minor: 1, suggestion: 0 },
        },
        {
          agentId: 'test-reviewer',
          harness: 'codex',
          approved: true,
          findings: { critical: 0, major: 0, minor: 0, suggestion: 1 },
        },
        {
          agentId: 'security-reviewer',
          harness: 'codex',
          approved: true,
          findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        },
      ]),
    );
    const res = runHelper(
      fixture.root,
      ['--review-verdicts', verdictsPath, '--iteration-count', '1', '--harness-note', ''],
      { HOME: tmpHome, GIT_AUTHOR_EMAIL: 'dev@example.com' },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);
    const envPath = join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.dsse.json`);
    const envelope = JSON.parse(readFileSync(envPath, 'utf-8'));
    const predicate = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8'));

    const codeReviewer = predicate.reviewers.find((r) => r.agentId === 'code-reviewer');
    assert.ok(codeReviewer, 'code-reviewer must appear in predicate reviewers');
    assert.equal(codeReviewer.findings.critical, 2, 'legacy: code-reviewer critical count');
    assert.equal(codeReviewer.findings.major, 3, 'legacy: code-reviewer major count');
    assert.equal(codeReviewer.findings.minor, 1, 'legacy: code-reviewer minor count');

    const testReviewer = predicate.reviewers.find((r) => r.agentId === 'test-reviewer');
    assert.ok(testReviewer, 'test-reviewer must appear in predicate reviewers');
    assert.equal(testReviewer.findings.suggestion, 1, 'legacy: test-reviewer suggestion count');
  });

  // ── AISDLC-274: single-envelope-per-PR invariant ──────────────────────

  it('AISDLC-274: second sign deletes the first envelope (single-envelope invariant)', () => {
    // Simulates the stale-envelope accumulation bug: sign at HEAD (round 1),
    // then simulate a rebase by adding a new commit and updating origin/main
    // to point at the old HEAD, then signing again at the new HEAD (round 2).
    // The second sign must:
    //   (a) delete the round-1 envelope (it was added by this PR vs origin/main)
    //   (b) write the round-2 envelope at the new HEAD SHA
    //   (c) leave exactly 1 envelope in .ai-sdlc/attestations/
    writeKey(tmpHome);

    const verdicts = JSON.stringify([
      {
        agentId: 'code-reviewer',
        harness: 'codex',
        approved: true,
        findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
      },
      {
        agentId: 'test-reviewer',
        harness: 'codex',
        approved: true,
        findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
      },
      {
        agentId: 'security-reviewer',
        harness: 'codex',
        approved: true,
        findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
      },
    ]);
    const verdictsPath = join(fixture.root, 'verdicts.json');
    writeFileSync(verdictsPath, verdicts);

    // Round 1: sign at the current HEAD (fixture.headSha).
    const res1 = runHelper(
      fixture.root,
      ['--review-verdicts', verdictsPath, '--iteration-count', '1', '--harness-note', ''],
      { HOME: tmpHome, GIT_AUTHOR_EMAIL: 'dev@example.com' },
    );
    assert.equal(res1.status, 0, `round-1 sign failed: ${res1.stderr}`);
    const round1Envelope = join(
      fixture.root,
      '.ai-sdlc',
      'attestations',
      `${fixture.headSha}.dsse.json`,
    );
    assert.ok(existsSync(round1Envelope), 'round-1 envelope must exist after first sign');

    // Simulate a queue rebase: commit the attestation file as a chore commit
    // (so it's on the branch), then add another commit on top (new HEAD).
    git(['add', join(fixture.root, '.ai-sdlc', 'attestations')], fixture.root);
    git(['commit', '-q', '-m', 'chore: auto-sign attestation for AISDLC-274'], fixture.root);
    // Simulate a rebase by making a new dev commit on top.
    writeFileSync(join(fixture.root, 'feature2.txt'), 'second feature\n');
    git(['add', 'feature2.txt'], fixture.root);
    git(['commit', '-q', '-m', 'feat: second feature (post-rebase)'], fixture.root);
    const newHeadSha = git(['rev-parse', 'HEAD'], fixture.root).trim();

    // Round 2: sign at the new HEAD. The old envelope (round1Envelope) was
    // added by the PR's diff vs origin/main and must be deleted.
    writeFileSync(verdictsPath, verdicts);
    const res2 = runHelper(
      fixture.root,
      ['--review-verdicts', verdictsPath, '--iteration-count', '1', '--harness-note', ''],
      { HOME: tmpHome, GIT_AUTHOR_EMAIL: 'dev@example.com' },
    );
    assert.equal(res2.status, 0, `round-2 sign failed: ${res2.stderr}`);

    // The round-1 envelope must be gone.
    assert.equal(
      existsSync(round1Envelope),
      false,
      'round-1 envelope must be deleted by the second sign (AISDLC-274)',
    );
    // The round-2 envelope must exist at the new HEAD SHA.
    const round2Envelope = join(
      fixture.root,
      '.ai-sdlc',
      'attestations',
      `${newHeadSha}.dsse.json`,
    );
    assert.ok(existsSync(round2Envelope), 'round-2 envelope must exist at the new HEAD SHA');

    // Exactly 1 envelope must remain.
    const attDir = join(fixture.root, '.ai-sdlc', 'attestations');
    const envelopes = readdirSync(attDir).filter((f) => f.endsWith('.dsse.json'));
    assert.equal(
      envelopes.length,
      1,
      `expected exactly 1 envelope after round-2 sign, got ${envelopes.length}: ${envelopes.join(', ')}`,
    );
  });
});
