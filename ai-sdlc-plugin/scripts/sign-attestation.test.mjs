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
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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
});
