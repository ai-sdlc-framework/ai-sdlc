/**
 * Integration tests for `scripts/verify-attestation.mjs` — the verifier the
 * `verify-attestation.yml` workflow shells out to (AISDLC-74 / AISDLC-84).
 *
 * Covers the workflow contract end-to-end against a synthetic git repo so
 * the regression cases (rebase, amend, force-push diff change, policy edit,
 * agent edit) exercise the same hash + signature codepath that production
 * runs.
 *
 * Run with: node --test scripts/verify-attestation.test.mjs
 *
 * AC traceability (AISDLC-84):
 *   - AC #1/#2 (predicate-content match selection — exactly-one / multi / zero)
 *   - AC #3   (signature verification still runs against trusted-reviewers.yaml)
 *   - AC #4   (schema-version allowlist still runs)
 *   - AC #6   (rebase: new HEAD SHA, same diff content → accepts)
 *   - AC #7   (amend with no diff change → accepts)
 *   - AC #8   (force-push that changes the diff → rejects with diffHash mismatch)
 *   - AC #9   (policy edit after sign → rejects with policyHash mismatch)
 *   - AC #10  (agent file edit after sign → rejects with agentFileHashes[<name>] mismatch)
 *   - AC #11  (cross-PR copy with different diff → rejects)
 *   - AC #12  (schemaVersion not in allowlist → rejects)
 *   - AC #13  (signature from untrusted pubkey → rejects)
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildGithubOutputLines,
  findChoreCommitViolations,
  loadAllAttestations,
  parseTrustedReviewers,
  predicateMatchReason,
  resolveAncestorDepth,
  resolveSubjectShaForEnvelope,
  runVerifier,
} from './verify-attestation.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// We need the orchestrator runtime helpers to actually sign the attestations
// in our fixtures. Import the compiled JS — the workflow does the same via
// `pnpm --filter @ai-sdlc/orchestrator build`.
const orchestratorBarrel = join(
  __dirname,
  '..',
  'orchestrator',
  'dist',
  'runtime',
  'attestations.js',
);

let buildPredicate;
let signAttestation;
let generateSigningKeyPair;

before(async () => {
  // Make sure the orchestrator is built so our import below resolves.
  try {
    execFileSync('pnpm', ['--filter', '@ai-sdlc/orchestrator', 'build'], {
      cwd: join(__dirname, '..'),
      stdio: 'pipe',
    });
  } catch (err) {
    throw new Error(`failed to build orchestrator: ${err.stderr?.toString() ?? err.message}`);
  }
  const mod = await import(orchestratorBarrel);
  buildPredicate = mod.buildPredicate;
  signAttestation = mod.signAttestation;
  generateSigningKeyPair = mod.generateSigningKeyPair;
});

// Strip git-context env vars so subprocess `git init` doesn't leak into the
// real repo (per AISDLC-72, mirrored in `cleanGitEnv`).
function cleanEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf-8' });
}

const REVIEW_POLICY = '# review policy v1\nGolden rule: when in doubt, approve.\n';
const AGENT_FILES = {
  'code-reviewer': '---\nname: code-reviewer\n---\nbody1\n',
  'test-reviewer': '---\nname: test-reviewer\n---\nbody2\n',
  'security-reviewer': '---\nname: security-reviewer\n---\nbody3\n',
};
// Plugin manifest baseline. Tests can override by writing a different
// version into the fixture's plugin.json before runVerifier.
const PLUGIN_VERSION = '0.7.1';

function setupFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-verify-test-'));
  // Minimal repo skeleton.
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  // Required files for the verifier.
  mkdirSync(join(root, '.ai-sdlc', 'attestations'), { recursive: true });
  mkdirSync(join(root, 'ai-sdlc-plugin', 'agents'), { recursive: true });
  writeFileSync(join(root, '.ai-sdlc', 'review-policy.md'), REVIEW_POLICY);
  for (const [name, content] of Object.entries(AGENT_FILES)) {
    writeFileSync(join(root, 'ai-sdlc-plugin', 'agents', `${name}.md`), content);
  }
  writeFileSync(
    join(root, 'ai-sdlc-plugin', 'plugin.json'),
    JSON.stringify({ name: 'ai-sdlc', version: PLUGIN_VERSION }, null, 2),
  );
  // Initial commit (this is the BASE the PR diffs against).
  writeFileSync(join(root, 'baseline.txt'), 'baseline\n');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'baseline'], root);
  const baseSha = git(['rev-parse', 'HEAD'], root).trim();
  // Add a feature commit (this is the HEAD).
  writeFileSync(join(root, 'feature.txt'), 'feature\n');
  git(['add', 'feature.txt'], root);
  git(['commit', '-q', '-m', 'feature'], root);
  const headSha = git(['rev-parse', 'HEAD'], root).trim();
  return { root, baseSha, headSha };
}

function writeTrustedReviewersYaml(root, pubkeyPem) {
  const yaml =
    [
      '# trusted reviewers test fixture',
      'reviewers:',
      "  - identity: 'dev@example.com'",
      "    machine: 'laptop'",
      "    addedAt: '2026-04-27'",
      "    addedBy: 'maintainer'",
      '    pubkey: |',
      ...pubkeyPem
        .trimEnd()
        .split('\n')
        .map((l) => `      ${l}`),
    ].join('\n') + '\n';
  writeFileSync(join(root, '.ai-sdlc', 'trusted-reviewers.yaml'), yaml);
}

// `subjectSha` is what gets baked into the envelope's predicate AND used as
// the filename. The verifier no longer enforces it (AISDLC-84), but we keep
// it accurate to the original convention so audit-trail readers see a real
// SHA on disk. Defaults to `headSha` for callers that don't care.
function writeAttestation(root, subjectSha, baseSha, headSha, privateKeyPem, overrides = {}) {
  const diff = git(['diff', `${baseSha}...${headSha}`], root);
  const policy = readFileSync(join(root, '.ai-sdlc', 'review-policy.md'), 'utf-8');
  const reviewers = Object.entries(AGENT_FILES).map(([agentId, content]) => ({
    agentId,
    agentFileContent: content,
    harness: 'codex',
    approved: true,
    findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
  }));
  const predicate = buildPredicate({
    commitSha: subjectSha,
    diff,
    policy,
    reviewers,
    pluginVersion: PLUGIN_VERSION,
    iterationCount: 1,
    harnessNote: '',
    signedAt: '2026-04-27T00:00:00.000Z',
    ...overrides,
  });
  if (overrides.predicateOverride) Object.assign(predicate, overrides.predicateOverride);
  const envelope = signAttestation({
    predicate,
    privateKeyPem,
    keyid: 'dev@example.com:laptop',
  });
  writeFileSync(
    join(root, '.ai-sdlc', 'attestations', `${subjectSha}.dsse.json`),
    JSON.stringify(envelope, null, 2),
  );
  return { predicate, envelope };
}

describe('parseTrustedReviewers', () => {
  it('parses a single reviewer entry with PEM block', () => {
    const yaml = `# header
reviewers:
  - identity: 'a@b.com'
    machine: 'laptop'
    addedAt: '2026-04-27'
    addedBy: 'reviewer'
    pubkey: |
      -----BEGIN PUBLIC KEY-----
      MCowBQYDK2VwAyEA
      -----END PUBLIC KEY-----
`;
    const { reviewers } = parseTrustedReviewers(yaml);
    assert.equal(reviewers.length, 1);
    assert.equal(reviewers[0].identity, 'a@b.com');
    assert.equal(reviewers[0].machine, 'laptop');
    assert.equal(reviewers[0].addedAt, '2026-04-27');
    assert.equal(reviewers[0].addedBy, 'reviewer');
    assert.match(reviewers[0].pubkey, /BEGIN PUBLIC KEY/);
    assert.match(reviewers[0].pubkey, /END PUBLIC KEY/);
  });

  it('returns empty list for the empty fixture file', () => {
    const yaml = '# all comments\nreviewers: []\n';
    const { reviewers } = parseTrustedReviewers(yaml);
    assert.deepEqual(reviewers, []);
  });

  it('parses multiple reviewers', () => {
    const yaml = `reviewers:
  - identity: 'a@x.com'
    machine: 'm1'
    addedAt: '2026-01-01'
    addedBy: 'r1'
    pubkey: |
      -----BEGIN PUBLIC KEY-----
      AAA
      -----END PUBLIC KEY-----
  - identity: 'b@y.com'
    machine: 'm2'
    addedAt: '2026-02-02'
    addedBy: 'r2'
    pubkey: |
      -----BEGIN PUBLIC KEY-----
      BBB
      -----END PUBLIC KEY-----
`;
    const { reviewers } = parseTrustedReviewers(yaml);
    assert.equal(reviewers.length, 2);
    assert.equal(reviewers[0].identity, 'a@x.com');
    assert.equal(reviewers[1].identity, 'b@y.com');
    assert.match(reviewers[0].pubkey, /AAA/);
    assert.match(reviewers[1].pubkey, /BBB/);
  });
});

describe('runVerifier (happy path + existing AISDLC-74 regressions)', () => {
  let fixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('returns valid for a freshly-signed attestation matching all PR state', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    writeTrustedReviewersYaml(fixture.root, publicKeyPem);
    writeAttestation(
      fixture.root,
      fixture.headSha,
      fixture.baseSha,
      fixture.headSha,
      privateKeyPem,
    );

    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'valid', `expected valid, got ${out.status}: ${out.reason}`);
    assert.equal(out.reason, 'ok');
  });

  it('returns invalid (missing) when no envelope file exists', () => {
    const { publicKeyPem } = generateSigningKeyPair();
    writeTrustedReviewersYaml(fixture.root, publicKeyPem);
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'invalid');
    assert.match(out.reason, /missing/);
  });

  it('AC #9: rejects (policyHash mismatch) after .ai-sdlc/review-policy.md edit', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    writeTrustedReviewersYaml(fixture.root, publicKeyPem);
    writeAttestation(
      fixture.root,
      fixture.headSha,
      fixture.baseSha,
      fixture.headSha,
      privateKeyPem,
    );
    // Edit the policy AFTER signing. Verifier should reject.
    writeFileSync(
      join(fixture.root, '.ai-sdlc', 'review-policy.md'),
      REVIEW_POLICY + '\n## new section after attestation\n',
    );
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'invalid');
    assert.match(out.reason, /policyHash mismatch/);
  });

  it('AC #10: rejects (agentFileHashes mismatch) after a reviewer agent edit', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    writeTrustedReviewersYaml(fixture.root, publicKeyPem);
    writeAttestation(
      fixture.root,
      fixture.headSha,
      fixture.baseSha,
      fixture.headSha,
      privateKeyPem,
    );
    // Edit the code-reviewer agent file AFTER signing. Verifier should reject
    // with the specific agent ID in the reason (AC #10).
    writeFileSync(
      join(fixture.root, 'ai-sdlc-plugin', 'agents', 'code-reviewer.md'),
      AGENT_FILES['code-reviewer'] + '\n## ADDED RULES AFTER ATTESTATION\n',
    );
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'invalid');
    assert.match(
      out.reason,
      /agentFileHashes\[code-reviewer\]|agentFileHash mismatch.*code-reviewer/,
    );
  });

  it('AC #12: rejects (schemaVersion) when envelope claims a non-allowlisted version', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    writeTrustedReviewersYaml(fixture.root, publicKeyPem);
    // Sign with v1 then mutate the payload to v99. Without re-signing the
    // signature will not verify, but the predicate-content scan rejects on
    // schemaVersion FIRST so the closest-mismatch reason should surface
    // the schemaVersion failure, not the signature failure.
    writeAttestation(
      fixture.root,
      fixture.headSha,
      fixture.baseSha,
      fixture.headSha,
      privateKeyPem,
    );
    const envPath = join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.dsse.json`);
    const envelope = JSON.parse(readFileSync(envPath, 'utf-8'));
    const predicate = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8'));
    predicate.schemaVersion = 'v99';
    envelope.payload = Buffer.from(JSON.stringify(predicate), 'utf-8').toString('base64');
    writeFileSync(envPath, JSON.stringify(envelope, null, 2));
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'invalid');
    assert.match(out.reason, /schemaVersion.*v99|schemaVersion not in/);
  });

  it('AC #13: rejects (signature) when the attestation was signed with an untrusted key', () => {
    const { privateKeyPem } = generateSigningKeyPair();
    const { publicKeyPem: otherPubkey } = generateSigningKeyPair();
    writeTrustedReviewersYaml(fixture.root, otherPubkey);
    writeAttestation(
      fixture.root,
      fixture.headSha,
      fixture.baseSha,
      fixture.headSha,
      privateKeyPem,
    );
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'invalid');
    assert.match(out.reason, /signature did not match/);
  });
});

// ─── AISDLC-84 — rebase-stable matching ─────────────────────────────
//
// The whole point of AISDLC-84: SHA can change for non-content reasons
// (rebase, amend, force-push of a no-op edit) and the verifier must still
// accept the existing attestation as long as the CONTENT bindings still
// match current PR state.

describe('runVerifier (AISDLC-84 — rebase / amend / force-push)', () => {
  let fixture;
  let keys;

  beforeEach(() => {
    fixture = setupFixture();
    keys = generateSigningKeyPair();
    writeTrustedReviewersYaml(fixture.root, keys.publicKeyPem);
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('AC #6: accepts after a rebase that rewrites HEAD SHA but keeps the same diff content', () => {
    // Sign against the pre-rebase HEAD.
    writeAttestation(
      fixture.root,
      fixture.headSha,
      fixture.baseSha,
      fixture.headSha,
      keys.privateKeyPem,
    );
    // Simulate "rebase onto main" — the diff content is unchanged but the
    // commit's metadata (committer-date) shifts, producing a new SHA. We
    // use `git commit-tree` directly so we get a fresh SHA without
    // touching the working tree, mirroring what `git rebase` would do
    // for a single commit on top of an unchanged base.
    const tree = git(['rev-parse', 'HEAD^{tree}'], fixture.root).trim();
    const message = git(['log', '-1', '--pretty=%B', 'HEAD'], fixture.root).trim();
    // GIT_COMMITTER_DATE override → different SHA, identical tree + parent.
    const env = {
      ...cleanEnv(),
      GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z',
      GIT_AUTHOR_DATE: '2030-01-01T00:00:00Z',
    };
    const newSha = execFileSync(
      'git',
      ['commit-tree', tree, '-p', fixture.baseSha, '-m', message],
      { cwd: fixture.root, env, encoding: 'utf-8' },
    ).trim();
    git(['update-ref', 'HEAD', newSha], fixture.root);
    assert.notEqual(newSha, fixture.headSha, 'rebase must produce a new SHA');
    // Diff content from base to new HEAD is identical to base→old HEAD.
    const oldDiff = readFileSync(
      join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.dsse.json`),
      'utf-8',
    );
    void oldDiff;
    const out = runVerifier({
      headSha: newSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'valid', `expected valid after rebase, got: ${out.reason}`);
    assert.equal(out.reason, 'ok');
  });

  it('AC #7: accepts after `git commit --amend --no-edit -m <new msg>` (message-only change)', () => {
    // Sign + then amend the commit message. Tree (= diff) is unchanged.
    writeAttestation(
      fixture.root,
      fixture.headSha,
      fixture.baseSha,
      fixture.headSha,
      keys.privateKeyPem,
    );
    git(['commit', '--amend', '-q', '-m', 'feature (with edited message)'], fixture.root);
    const newHead = git(['rev-parse', 'HEAD'], fixture.root).trim();
    assert.notEqual(newHead, fixture.headSha);
    const out = runVerifier({
      headSha: newHead,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'valid', `expected valid after amend, got: ${out.reason}`);
  });

  it('AC #8: rejects (diffHash mismatch) when force-push actually changes the diff', () => {
    writeAttestation(
      fixture.root,
      fixture.headSha,
      fixture.baseSha,
      fixture.headSha,
      keys.privateKeyPem,
    );
    // Amend with extra content. Now the diff genuinely differs.
    writeFileSync(join(fixture.root, 'feature.txt'), 'feature\nMORE CONTENT\n');
    git(['add', 'feature.txt'], fixture.root);
    git(['commit', '--amend', '-q', '--no-edit'], fixture.root);
    const newHead = git(['rev-parse', 'HEAD'], fixture.root).trim();
    const out = runVerifier({
      headSha: newHead,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'invalid');
    assert.match(out.reason, /diffHash mismatch/);
  });

  it('AC #11: rejects (diffHash mismatch) when an attestation from another PR is copy-pasted', () => {
    // Build a second fixture and add an extra commit so its diff genuinely
    // differs from PR-B (= the outer `fixture`). Sign PR-A's attestation,
    // copy it onto PR-B's branch, then verify against PR-B's state —
    // should reject because PR-A's attested diffHash doesn't match
    // PR-B's recomputed diff.
    const otherFixture = setupFixture();
    try {
      // Make PR-A's diff genuinely different from PR-B's:
      writeFileSync(join(otherFixture.root, 'extra-pr-a.txt'), 'this file only exists in PR-A\n');
      git(['add', 'extra-pr-a.txt'], otherFixture.root);
      git(['commit', '-q', '-m', 'PR-A only commit'], otherFixture.root);
      const prAHead = git(['rev-parse', 'HEAD'], otherFixture.root).trim();
      writeTrustedReviewersYaml(otherFixture.root, keys.publicKeyPem);
      // Sign PR-A's attestation against its different head + diff.
      writeAttestation(
        otherFixture.root,
        prAHead,
        otherFixture.baseSha,
        prAHead,
        keys.privateKeyPem,
      );
      const prAEnvelope = readFileSync(
        join(otherFixture.root, '.ai-sdlc', 'attestations', `${prAHead}.dsse.json`),
        'utf-8',
      );
      // Copy PR-A's envelope file into PR-B's attestations directory.
      writeFileSync(
        join(fixture.root, '.ai-sdlc', 'attestations', `${prAHead}.dsse.json`),
        prAEnvelope,
      );
      const out = runVerifier({
        headSha: fixture.headSha,
        baseSha: fixture.baseSha,
        repoRoot: fixture.root,
      });
      assert.equal(out.status, 'invalid');
      assert.match(out.reason, /diffHash mismatch/);
    } finally {
      rmSync(otherFixture.root, { recursive: true, force: true });
    }
  });

  it('AC #2: when multiple envelopes match, picks the most recently signed', () => {
    // Plant TWO envelopes that both pass the predicate-content match
    // (same diff + same policy + same agents + same plugin version),
    // signed at different timestamps. The newer one wins. We assert this
    // by giving the OLDER envelope a different keyid + signing it with a
    // SECOND key that's NOT trusted; if the verifier picks the older one,
    // signature verification fails (= "signature did not match"). The
    // pass-through to status=valid proves it picked the newer one.
    const otherKeys = generateSigningKeyPair();
    // Old envelope, signed with untrusted key.
    {
      const diff = git(['diff', `${fixture.baseSha}...${fixture.headSha}`], fixture.root);
      const policy = readFileSync(join(fixture.root, '.ai-sdlc', 'review-policy.md'), 'utf-8');
      const reviewers = Object.entries(AGENT_FILES).map(([agentId, content]) => ({
        agentId,
        agentFileContent: content,
        harness: 'codex',
        approved: true,
        findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
      }));
      const predicate = buildPredicate({
        commitSha: 'a'.repeat(40),
        diff,
        policy,
        reviewers,
        pluginVersion: PLUGIN_VERSION,
        iterationCount: 1,
        harnessNote: '',
        signedAt: '2024-01-01T00:00:00.000Z', // OLDER
      });
      const envelope = signAttestation({
        predicate,
        privateKeyPem: otherKeys.privateKeyPem,
        keyid: 'untrusted',
      });
      writeFileSync(
        join(fixture.root, '.ai-sdlc', 'attestations', `${'a'.repeat(40)}.dsse.json`),
        JSON.stringify(envelope, null, 2),
      );
    }
    // New envelope, signed with trusted key.
    writeAttestation(
      fixture.root,
      fixture.headSha,
      fixture.baseSha,
      fixture.headSha,
      keys.privateKeyPem,
      { signedAt: '2026-04-27T00:00:00.000Z' },
    );
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'valid', `expected valid, got: ${out.reason}`);
  });
});

// ─── AISDLC-85 — chore-commit-on-top fix ────────────────────────────
//
// The standard `/ai-sdlc execute` shape signs at the dev commit's HEAD
// THEN adds a chore commit (file move + attestation file) on top. AISDLC-84
// computed diffHash from PR HEAD's diff, which included the chore commit,
// so the attestation never verified. AISDLC-85 recomputes diffHash from
// each envelope's `subject.digest.sha1` (the dev commit's SHA at sign time)
// and gates on a chore-commit allowlist to prevent malicious chore commits.

describe('runVerifier (AISDLC-85 — chore-commit-on-top)', () => {
  let fixture;
  let keys;

  beforeEach(() => {
    fixture = setupFixture();
    keys = generateSigningKeyPair();
    writeTrustedReviewersYaml(fixture.root, keys.publicKeyPem);
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  /**
   * Helper: simulate the exact `/ai-sdlc execute` Step 10 sequence.
   * 1. Sign attestation against the current HEAD (= dev commit).
   * 2. Layer a chore commit on top that adds the attestation file +
   *    optionally moves a backlog task file from tasks/ to completed/.
   * 3. Optionally inject extra files into the chore commit (for the
   *    malicious-chore-commit AC #5 case).
   *
   * Returns the SHAs at each step.
   */
  function simulateExecuteStep10({ extraChoreFiles = {}, includeTaskMove = true } = {}) {
    // Pre-populate a backlog task file BEFORE the dev commit so the
    // chore commit can move it. The task file is part of the BASE,
    // matching the shape of a real run.
    if (includeTaskMove) {
      mkdirSync(join(fixture.root, 'backlog', 'tasks'), { recursive: true });
      writeFileSync(
        join(fixture.root, 'backlog', 'tasks', 'aisdlc-99-task.md'),
        '# task body\nstatus: To Do\n',
      );
      git(['add', 'backlog/tasks/aisdlc-99-task.md'], fixture.root);
      git(['commit', '-q', '-m', 'add task file'], fixture.root);
    }
    // Re-grab base + head AFTER any prep commits, so the dev commit
    // diffs against the post-prep state. The verifier's PR_BASE_SHA is
    // origin/main's tip; in this test it's whatever HEAD was before
    // the dev commit landed.
    const baseSha = git(['rev-parse', 'HEAD'], fixture.root).trim();
    // Dev commit — substantive change (the reviewed work).
    writeFileSync(join(fixture.root, 'src-feature.txt'), 'reviewed feature\n');
    git(['add', 'src-feature.txt'], fixture.root);
    git(['commit', '-q', '-m', 'feat: reviewed feature'], fixture.root);
    const devSha = git(['rev-parse', 'HEAD'], fixture.root).trim();
    // Sign attestation against devSha. Match the real signer: the
    // diff range is `<base>...<devSha>` (NOT `<base>...<HEAD-after-chore>`).
    writeAttestation(fixture.root, devSha, baseSha, devSha, keys.privateKeyPem);
    // Chore commit on top: add attestation file + optionally move task.
    // `git mv` requires the destination directory to exist already, so
    // mkdirSync first.
    if (includeTaskMove) {
      mkdirSync(join(fixture.root, 'backlog', 'completed'), { recursive: true });
      git(
        ['mv', 'backlog/tasks/aisdlc-99-task.md', 'backlog/completed/aisdlc-99-task.md'],
        fixture.root,
      );
      // Touch the moved file so the chore commit also "edits" it (mirrors
      // the real `task_edit Done → task_complete` sequence which writes
      // the new status into the file).
      writeFileSync(
        join(fixture.root, 'backlog', 'completed', 'aisdlc-99-task.md'),
        '# task body\nstatus: Done\n',
      );
    }
    // Stage the attestation file (it was written to disk by writeAttestation
    // but git doesn't know about it yet).
    git(['add', '.ai-sdlc/attestations'], fixture.root);
    // Stage extra files (used by AC #5 to smuggle a .ts file into chore).
    for (const [path, content] of Object.entries(extraChoreFiles)) {
      mkdirSync(join(fixture.root, dirname(path)), { recursive: true });
      writeFileSync(join(fixture.root, path), content);
      git(['add', path], fixture.root);
    }
    git(['commit', '-q', '-m', 'chore: attest + complete task'], fixture.root);
    const headSha = git(['rev-parse', 'HEAD'], fixture.root).trim();
    return { baseSha, devSha, headSha };
  }

  it('AC #3: accepts the standard dev-commit + chore-commit shape from /ai-sdlc execute', () => {
    const { baseSha, devSha, headSha } = simulateExecuteStep10();
    assert.notEqual(devSha, headSha, 'chore commit must add a real new SHA on top');
    const out = runVerifier({ headSha, baseSha, repoRoot: fixture.root });
    assert.equal(
      out.status,
      'valid',
      `expected valid for dev+chore shape, got ${out.status}: ${out.reason}`,
    );
    assert.equal(out.reason, 'ok');
  });

  it('AC #4: accepts after a rebase rewrites the dev commit SHA — falls back to ancestor walk', () => {
    // First land a normal dev+chore PR.
    const { baseSha, devSha, headSha } = simulateExecuteStep10();
    assert.notEqual(devSha, headSha);
    // Now simulate a post-sign rebase: rewrite BOTH the dev commit and the
    // chore commit with new committer dates → new SHAs all the way down.
    // The envelope's `subject.digest.sha1` (== devSha) is now orphaned —
    // it's no longer reachable from PR HEAD. The verifier must fall back
    // to walking PR HEAD's first-parent ancestors and recomputing diff
    // hashes per ancestor.
    const devTree = git(['rev-parse', `${devSha}^{tree}`], fixture.root).trim();
    const devMessage = git(['log', '-1', '--pretty=%B', devSha], fixture.root).trim();
    const choreTree = git(['rev-parse', `${headSha}^{tree}`], fixture.root).trim();
    const choreMessage = git(['log', '-1', '--pretty=%B', headSha], fixture.root).trim();
    const env = {
      ...cleanEnv(),
      GIT_COMMITTER_DATE: '2030-06-15T00:00:00Z',
      GIT_AUTHOR_DATE: '2030-06-15T00:00:00Z',
    };
    const newDevSha = execFileSync(
      'git',
      ['commit-tree', devTree, '-p', baseSha, '-m', devMessage],
      { cwd: fixture.root, env, encoding: 'utf-8' },
    ).trim();
    const newHeadSha = execFileSync(
      'git',
      ['commit-tree', choreTree, '-p', newDevSha, '-m', choreMessage],
      { cwd: fixture.root, env, encoding: 'utf-8' },
    ).trim();
    git(['update-ref', 'HEAD', newHeadSha], fixture.root);
    assert.notEqual(newDevSha, devSha, 'rebase must produce new dev SHA');
    assert.notEqual(newHeadSha, headSha, 'rebase must produce new head SHA');
    // Sanity-check: the OLD devSha is no longer reachable from new HEAD.
    let oldStillReachable = true;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', devSha, newHeadSha], {
        cwd: fixture.root,
        env: cleanEnv(),
      });
    } catch {
      oldStillReachable = false;
    }
    assert.equal(oldStillReachable, false, 'rebase should orphan the old dev SHA');

    const out = runVerifier({ headSha: newHeadSha, baseSha, repoRoot: fixture.root });
    assert.equal(
      out.status,
      'valid',
      `expected valid after rebase via ancestor walk, got ${out.status}: ${out.reason}`,
    );
    assert.equal(out.reason, 'ok');
  });

  it('AC #5 (security): rejects when the chore commit modifies code outside the allowlist', () => {
    // The malicious case: an attacker who controls a chore commit could
    // add a `.ts` file. The dev commit's attestation only covers the dev
    // commit's diff; if we accept this, the .ts file ships unreviewed.
    // Verifier MUST reject with `unexpected chore commit content`.
    const { baseSha, headSha } = simulateExecuteStep10({
      extraChoreFiles: {
        'src/malicious.ts': '// attacker-supplied code, never reviewed\nexport const evil = 1;\n',
      },
    });
    const out = runVerifier({ headSha, baseSha, repoRoot: fixture.root });
    assert.equal(out.status, 'invalid', `expected invalid, got ${out.status}: ${out.reason}`);
    assert.match(out.reason, /unexpected chore commit content/);
    assert.match(out.reason, /src\/malicious\.ts/);
  });

  it('AC #5 (security): rejects when the chore commit modifies a top-level file', () => {
    // Defense in depth: even a single non-allowlisted file (no `src/`
    // prefix) should be rejected. We use a top-level config file.
    const { baseSha, headSha } = simulateExecuteStep10({
      extraChoreFiles: {
        'package.json': '{"name": "smuggled"}\n',
      },
    });
    const out = runVerifier({ headSha, baseSha, repoRoot: fixture.root });
    assert.equal(out.status, 'invalid');
    assert.match(out.reason, /unexpected chore commit content/);
    assert.match(out.reason, /package\.json/);
  });

  it('accepts when chore commit ONLY moves the backlog task file (no extras)', () => {
    // Same as AC #3 but verify the explicit allowlist branch — the chore
    // commit's diff has both a `.dsse.json` add and `.md` add+delete. We
    // already covered this in AC #3 but make the assertion explicit so a
    // future regression that only tightens one allowlist pattern fails
    // visibly here.
    const { baseSha, headSha, devSha } = simulateExecuteStep10();
    const violations = findChoreCommitViolations({
      subjectSha: devSha,
      headSha,
      repoRoot: fixture.root,
    });
    assert.deepEqual(
      violations,
      [],
      `chore commit should be allowlist-clean, got ${JSON.stringify(violations)}`,
    );
    const out = runVerifier({ headSha, baseSha, repoRoot: fixture.root });
    assert.equal(out.status, 'valid', out.reason);
  });

  it('rejects when chore commit modifies the policy file (which lives outside the allowlist)', () => {
    // Edge case: the chore commit modifies `.ai-sdlc/review-policy.md`.
    // That's NOT in the chore allowlist (only `.ai-sdlc/attestations/*`
    // is). It would also fail the policyHash check, but we want the
    // chore-commit gate to fire FIRST so the operator sees the right
    // diagnostic.
    const { baseSha, headSha } = simulateExecuteStep10({
      extraChoreFiles: {
        '.ai-sdlc/review-policy.md':
          '# review policy v1\nGolden rule: when in doubt, approve.\n## ATTACKER ADDED\n',
      },
    });
    const out = runVerifier({ headSha, baseSha, repoRoot: fixture.root });
    assert.equal(out.status, 'invalid');
    // Either the chore-allowlist OR policyHash mismatch is acceptable —
    // both correctly reject the malicious change. We assert one of them.
    assert.match(
      out.reason,
      /(unexpected chore commit content.*review-policy\.md|policyHash mismatch)/,
    );
  });

  // ─── AISDLC-92 — unicode-named backlog task in chore commit ──────────
  //
  // Regression: when a backlog task title contained unicode (`—`, `→`),
  // Backlog.md derived a filename containing those chars. The chore commit
  // moved the file from `backlog/tasks/` to `backlog/completed/`. Git's
  // default `core.quotepath=true` octal-escaped + double-quoted that path
  // in `git diff --name-only` output (e.g. `"backlog/.../...\\342\\200\\224..."`).
  // The chore-commit allowlist regex (`^backlog/(tasks|completed)/.+\\.md$`)
  // is anchored on `^backlog`, so the leading `"` made it false-positive.
  // Verifier rejected with `unexpected chore commit content`, blocking the
  // PR (#101 / AISDLC-90). Fix: prepend `-c core.quotepath=false` to every
  // git invocation in the verifier's `git()` helper.
  it('AISDLC-92: accepts chore commit moving a unicode-named backlog task file', () => {
    // Pre-populate a backlog task file with unicode in its name BEFORE the
    // dev commit so the chore commit can move it. Mirrors the failure mode
    // observed when AISDLC-90's title used `—` and `→`.
    const unicodeTaskName = 'aisdlc-99 - Task-with-unicode-—-and-→-chars.md';
    mkdirSync(join(fixture.root, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(
      join(fixture.root, 'backlog', 'tasks', unicodeTaskName),
      '# task body\nstatus: To Do\n',
    );
    git(['add', `backlog/tasks/${unicodeTaskName}`], fixture.root);
    git(['commit', '-q', '-m', 'add unicode-named task'], fixture.root);
    const baseSha = git(['rev-parse', 'HEAD'], fixture.root).trim();

    // Dev commit — the substantive (reviewed) work.
    writeFileSync(join(fixture.root, 'src-feature.txt'), 'reviewed feature\n');
    git(['add', 'src-feature.txt'], fixture.root);
    git(['commit', '-q', '-m', 'feat: reviewed feature'], fixture.root);
    const devSha = git(['rev-parse', 'HEAD'], fixture.root).trim();

    // Sign attestation against the dev commit (matches `/ai-sdlc execute`
    // Step 10 ordering — sign BEFORE the chore commit lands).
    writeAttestation(fixture.root, devSha, baseSha, devSha, keys.privateKeyPem);

    // Chore commit on top: move the unicode task file + add the
    // attestation file. This is the exact shape that broke PR #101.
    mkdirSync(join(fixture.root, 'backlog', 'completed'), { recursive: true });
    git(
      ['mv', `backlog/tasks/${unicodeTaskName}`, `backlog/completed/${unicodeTaskName}`],
      fixture.root,
    );
    writeFileSync(
      join(fixture.root, 'backlog', 'completed', unicodeTaskName),
      '# task body\nstatus: Done\n',
    );
    git(['add', '.ai-sdlc/attestations'], fixture.root);
    git(['commit', '-q', '-m', 'chore: attest + complete task'], fixture.root);
    const headSha = git(['rev-parse', 'HEAD'], fixture.root).trim();

    // Direct check: violations must be empty (the regression that AISDLC-92
    // fixes — quotepath=true would emit `"backlog/...\\342..."` paths that
    // fail the `^backlog/(tasks|completed)/.+\\.md$` anchor).
    const violations = findChoreCommitViolations({
      subjectSha: devSha,
      headSha,
      repoRoot: fixture.root,
    });
    assert.deepEqual(
      violations,
      [],
      `unicode backlog filenames must NOT trigger chore-commit violations, got: ${JSON.stringify(violations)}`,
    );

    // End-to-end: the verifier accepts the PR.
    const out = runVerifier({ headSha, baseSha, repoRoot: fixture.root });
    assert.equal(
      out.status,
      'valid',
      `expected valid for unicode-task chore shape, got ${out.status}: ${out.reason}`,
    );
    assert.equal(out.reason, 'ok');
  });
});

// ─── AISDLC-85 — unit tests for the new helpers ──────────────────────

describe('resolveAncestorDepth (AISDLC-85)', () => {
  it('returns the default (5) for missing/empty values', () => {
    assert.equal(resolveAncestorDepth(undefined), 5);
    assert.equal(resolveAncestorDepth(null), 5);
    assert.equal(resolveAncestorDepth(''), 5);
  });

  it('returns the parsed value when valid', () => {
    assert.equal(resolveAncestorDepth('1'), 1);
    assert.equal(resolveAncestorDepth('10'), 10);
  });

  it('clamps to the hard cap (32)', () => {
    assert.equal(resolveAncestorDepth('1000'), 32);
    assert.equal(resolveAncestorDepth('33'), 32);
  });

  it('falls back to the default for invalid input', () => {
    assert.equal(resolveAncestorDepth('not-a-number'), 5);
    assert.equal(resolveAncestorDepth('-1'), 5);
    assert.equal(resolveAncestorDepth('0'), 5);
    assert.equal(resolveAncestorDepth('1.5'), 5);
  });
});

describe('findChoreCommitViolations (AISDLC-85)', () => {
  it('returns [] when subject == head (no chore commit)', () => {
    const calls = [];
    const fakeGit = (args) => {
      calls.push(args);
      return '';
    };
    const v = findChoreCommitViolations({
      subjectSha: 'a'.repeat(40),
      headSha: 'a'.repeat(40),
      repoRoot: '/tmp/fake',
      gitFn: fakeGit,
    });
    assert.deepEqual(v, []);
    assert.equal(calls.length, 0, 'should not invoke git when shas are equal');
  });

  it('returns [] when chore commit only touches allowlisted paths', () => {
    const fakeGit = () =>
      [
        '.ai-sdlc/attestations/abc.dsse.json',
        'backlog/tasks/aisdlc-99-task.md',
        'backlog/completed/aisdlc-99-task.md',
      ].join('\n') + '\n';
    const v = findChoreCommitViolations({
      subjectSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      repoRoot: '/tmp/fake',
      gitFn: fakeGit,
    });
    assert.deepEqual(v, []);
  });

  it('flags anything outside the allowlist (single .ts file)', () => {
    const fakeGit = () => ['.ai-sdlc/attestations/abc.dsse.json', 'src/malicious.ts'].join('\n');
    const v = findChoreCommitViolations({
      subjectSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      repoRoot: '/tmp/fake',
      gitFn: fakeGit,
    });
    assert.deepEqual(v, ['src/malicious.ts']);
  });

  it('flags allowed-prefix-but-wrong-extension files (e.g. attestations/foo.txt)', () => {
    const fakeGit = () => '.ai-sdlc/attestations/foo.txt';
    const v = findChoreCommitViolations({
      subjectSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      repoRoot: '/tmp/fake',
      gitFn: fakeGit,
    });
    assert.deepEqual(v, ['.ai-sdlc/attestations/foo.txt']);
  });

  it('flags backlog files outside tasks/ and completed/ subdirs', () => {
    const fakeGit = () => 'backlog/drafts/foo.md\nbacklog/foo.md';
    const v = findChoreCommitViolations({
      subjectSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      repoRoot: '/tmp/fake',
      gitFn: fakeGit,
    });
    assert.deepEqual(v, ['backlog/drafts/foo.md', 'backlog/foo.md']);
  });

  it('does not allow nested attestation paths (anchored to single segment)', () => {
    // `.ai-sdlc/attestations/sub/foo.dsse.json` should NOT pass the regex
    // (the `[^/]+` stops at directory separators). Defense against an
    // attacker creating `.ai-sdlc/attestations/payload/index.html`.
    const fakeGit = () => '.ai-sdlc/attestations/sub/foo.dsse.json';
    const v = findChoreCommitViolations({
      subjectSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      repoRoot: '/tmp/fake',
      gitFn: fakeGit,
    });
    assert.deepEqual(v, ['.ai-sdlc/attestations/sub/foo.dsse.json']);
  });

  it('AISDLC-92: accepts unicode-named backlog files when git emits raw UTF-8 paths', () => {
    // With `core.quotepath=false` (which the real `git()` helper now sets),
    // git emits raw UTF-8 path bytes — no leading `"` and no octal escape.
    // The allowlist regex is anchored on `^backlog`, so the unquoted path
    // matches normally. This test pins the post-fix behavior.
    const fakeGit = () =>
      [
        '.ai-sdlc/attestations/abc.dsse.json',
        'backlog/tasks/aisdlc-92 - Verifier-—-quotepath-→-fix.md',
        'backlog/completed/aisdlc-92 - Verifier-—-quotepath-→-fix.md',
      ].join('\n');
    const v = findChoreCommitViolations({
      subjectSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      repoRoot: '/tmp/fake',
      gitFn: fakeGit,
    });
    assert.deepEqual(v, []);
  });
});

describe('resolveSubjectShaForEnvelope (AISDLC-85)', () => {
  it('returns null when predicate.diffHash is missing', () => {
    const r = resolveSubjectShaForEnvelope({
      envelope: { payload: 'x' },
      predicate: {},
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      repoRoot: '/tmp/fake',
      depth: 5,
      gitFn: () => '',
    });
    assert.equal(r, null);
  });

  it('returns null when no ancestor diff matches', () => {
    // Stub git: merge-base says not-an-ancestor; rev-list returns one
    // commit; diff returns empty content (sha256 won't match the
    // 'wrongdiffhash...' value).
    const fakeGit = (args) => {
      if (args[0] === 'merge-base') {
        const err = new Error('not an ancestor');
        err.status = 1;
        throw err;
      }
      if (args[0] === 'rev-list') return 'b'.repeat(40) + '\n';
      if (args[0] === 'diff') return 'something different';
      return '';
    };
    const r = resolveSubjectShaForEnvelope({
      envelope: { payload: 'x' },
      predicate: {
        diffHash: '0'.repeat(64),
        subject: { digest: { sha1: 'c'.repeat(40) } },
      },
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      repoRoot: '/tmp/fake',
      depth: 5,
      gitFn: fakeGit,
    });
    assert.equal(r, null);
  });
});
describe('predicateMatchReason', () => {
  function baseExpected() {
    return {
      diffHash: 'a'.repeat(64),
      policyHash: 'b'.repeat(64),
      expectedAgentFileHashes: { 'code-reviewer': 'c'.repeat(64) },
      pluginVersion: '0.7.1',
      acceptedSchemaVersions: ['v1'],
    };
  }
  function basePredicate() {
    return {
      schemaVersion: 'v1',
      diffHash: 'a'.repeat(64),
      policyHash: 'b'.repeat(64),
      pluginVersion: '0.7.1',
      reviewers: [{ agentId: 'code-reviewer', agentFileHash: 'c'.repeat(64) }],
    };
  }

  it('returns null when every binding matches', () => {
    assert.equal(predicateMatchReason(basePredicate(), baseExpected()), null);
  });

  it('returns schemaVersion mismatch first when schema is wrong', () => {
    const r = predicateMatchReason({ ...basePredicate(), schemaVersion: 'v9' }, baseExpected());
    assert.equal(r.field, 'schemaVersion');
    assert.match(r.detail, /not in allowlist/);
  });

  it('returns diffHash mismatch when diff differs', () => {
    const r = predicateMatchReason(
      { ...basePredicate(), diffHash: 'x'.repeat(64) },
      baseExpected(),
    );
    assert.equal(r.field, 'diffHash');
  });

  it('returns policyHash mismatch when policy differs', () => {
    const r = predicateMatchReason(
      { ...basePredicate(), policyHash: 'x'.repeat(64) },
      baseExpected(),
    );
    assert.equal(r.field, 'policyHash');
  });

  it('returns agentFileHashes[<id>] mismatch when an agent file differs', () => {
    const p = basePredicate();
    p.reviewers[0].agentFileHash = 'x'.repeat(64);
    const r = predicateMatchReason(p, baseExpected());
    assert.match(r.field, /agentFileHashes\[code-reviewer\]/);
    assert.match(r.detail, /code-reviewer.*differs/);
  });

  it('returns pluginVersion mismatch when versions differ', () => {
    const r = predicateMatchReason({ ...basePredicate(), pluginVersion: '9.9.9' }, baseExpected());
    assert.equal(r.field, 'pluginVersion');
    assert.match(r.detail, /9\.9\.9/);
  });

  it('skips the pluginVersion check when expected.pluginVersion is empty', () => {
    const r = predicateMatchReason(
      { ...basePredicate(), pluginVersion: '9.9.9' },
      { ...baseExpected(), pluginVersion: '' },
    );
    assert.equal(r, null);
  });

  it('strips CR/LF from interpolated values to defend against $GITHUB_OUTPUT injection', () => {
    // The threat: a malicious schemaVersion containing `\n` could, if
    // emitted naively into $GITHUB_OUTPUT as `key=value\n`, smuggle a
    // duplicate `status=valid` key past the parser. CR/LF must be
    // stripped at the boundary. The literal text `status=valid` inside
    // the heredoc body is harmless (the heredoc writer wraps it), so
    // we only assert no raw newlines escape — the writer test covers
    // the rest of the chain.
    const r = predicateMatchReason(
      { ...basePredicate(), schemaVersion: 'v9\nstatus=valid' },
      baseExpected(),
    );
    assert.equal(r.field, 'schemaVersion');
    assert.equal(r.detail.includes('\n'), false);
    assert.equal(r.detail.includes('\r'), false);
  });
});

describe('loadAllAttestations', () => {
  it('returns an empty list when the attestations dir is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-verify-load-'));
    try {
      assert.deepEqual(loadAllAttestations(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('skips junk files (non-JSON, missing payload, undecodable predicate)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-verify-load-'));
    try {
      mkdirSync(join(root, '.ai-sdlc', 'attestations'), { recursive: true });
      writeFileSync(join(root, '.ai-sdlc', 'attestations', 'junk.dsse.json'), 'not json');
      writeFileSync(
        join(root, '.ai-sdlc', 'attestations', 'noPayload.dsse.json'),
        JSON.stringify({}),
      );
      writeFileSync(
        join(root, '.ai-sdlc', 'attestations', 'badPayload.dsse.json'),
        JSON.stringify({ payload: 'not-base64-json!' }),
      );
      writeFileSync(
        join(root, '.ai-sdlc', 'attestations', 'README.md'),
        'this should be ignored — wrong extension',
      );
      // One real-ish entry to make sure the scan still proceeds.
      const okPayload = Buffer.from(JSON.stringify({ schemaVersion: 'v1' }), 'utf-8').toString(
        'base64',
      );
      writeFileSync(
        join(root, '.ai-sdlc', 'attestations', 'real.dsse.json'),
        JSON.stringify({ payload: okPayload }),
      );
      const all = loadAllAttestations(root);
      assert.equal(all.length, 1);
      assert.equal(all[0].fileName, 'real.dsse.json');
      assert.equal(all[0].predicate.schemaVersion, 'v1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── GITHUB_OUTPUT writer (post-review hardening) ────────────────
//
// The original `appendFileSync(GITHUB_OUTPUT, \`status=${out.status}\nreason=${out.reason}\n\`)`
// was injection-prone: a malicious reason containing `\nstatus=valid` would
// emit two `status=` lines and GitHub Actions' last-write-wins parser would
// pick `valid`, bypassing the entire attestation trust boundary. The
// hardened writer uses a heredoc with an unguessable random delimiter.

describe('buildGithubOutputLines (injection-resistant writer)', () => {
  it('emits a status=KEY line and a reason heredoc block', () => {
    const out = buildGithubOutputLines('valid', 'ok');
    assert.match(out, /^status=valid\n/);
    assert.match(out, /reason<<EOF_[0-9a-f]{64}\n/);
    assert.match(out, /\nok\nEOF_[0-9a-f]{64}\n$/);
  });

  it('uses a fresh random delimiter per call (unpredictable to attacker)', () => {
    const a = buildGithubOutputLines('valid', 'ok');
    const b = buildGithubOutputLines('valid', 'ok');
    const delimA = a.match(/EOF_([0-9a-f]{64})/)[1];
    const delimB = b.match(/EOF_([0-9a-f]{64})/)[1];
    assert.notEqual(delimA, delimB, 'delimiter must be random per invocation');
  });

  it('cannot inject a duplicate status= line via newline in reason (CRITICAL)', () => {
    // The exact attack: reason contains `\nstatus=valid` which would, in a
    // naive `key=value\n` implementation, emit a second `status=` line that
    // GitHub Actions parses as a duplicate key (last-wins → `valid`).
    //
    // With heredoc: the injection lines ARE present in the file as raw
    // bytes, but they're INSIDE a `reason<<EOF_<random>` block, so GitHub
    // Actions parses them as part of the reason value, not as new keys.
    // We model GitHub's parser here: split on the heredoc boundary, then
    // count `^status=` only OUTSIDE the heredoc body.
    const out = buildGithubOutputLines(
      'invalid',
      'subject digest mismatch\nstatus=valid\nreason=oops',
    );
    const lines = out.split('\n');
    const openIdx = lines.findIndex((l) => /^reason<<EOF_[0-9a-f]{64}$/.test(l));
    assert.notEqual(openIdx, -1, 'must include a heredoc opener');
    const delim = lines[openIdx].slice('reason<<'.length);
    const closeIdx = lines.findIndex((l, i) => i > openIdx && l === delim);
    assert.notEqual(closeIdx, -1, 'must include a closing delimiter');
    // Lines OUTSIDE the heredoc body (before opener + at/after closer).
    const outsideHeredoc = [...lines.slice(0, openIdx), ...lines.slice(closeIdx)];
    const statusLines = outsideHeredoc.filter((l) => /^status=/.test(l));
    assert.equal(statusLines.length, 1, 'exactly one status= line outside the heredoc');
    assert.equal(statusLines[0], 'status=invalid');
    const reasonKeyLines = outsideHeredoc.filter((l) => /^reason=/.test(l));
    assert.equal(
      reasonKeyLines.length,
      0,
      `should be 0 reason= key= lines (we use heredoc form), got ${reasonKeyLines.length}`,
    );
  });

  it('strips lines that match the random delimiter (defense-in-depth)', () => {
    // We can't predict the delimiter, but we can confirm that a reason
    // ending in `EOF_<actual-delim>` would not close the heredoc early.
    // Easier check: feed a reason WITH some of the prefix, ensure the
    // structure stays well-formed and the delimiter at the end is intact.
    const out = buildGithubOutputLines('invalid', 'EOF_short_partial\nmore');
    const lines = out.split('\n');
    // Last non-empty line must be the closing heredoc delimiter.
    const nonEmpty = lines.filter((l) => l.length > 0);
    assert.match(nonEmpty[nonEmpty.length - 1], /^EOF_[0-9a-f]{64}$/);
  });

  it('rejects unknown status (only valid/invalid permitted)', () => {
    assert.throws(() => buildGithubOutputLines('maybe', 'ok'), /must be 'valid' or 'invalid'/);
  });
});

describe('runVerifier (injection regression)', () => {
  it('rejects an attestation where sha1 carries a literal `\\nstatus=valid` (CRITICAL)', () => {
    // Under AISDLC-84 the verifier no longer indexes envelopes by sha1, so
    // the attack surface shifts: a malicious sha1 with embedded `\n` lands
    // in the predicate, and `verifyAttestation` (orchestrator runtime)
    // shape-validates it. Either (a) the predicate-content scan mismatches
    // first (because the diff/policy/etc. don't match the malicious
    // envelope) so the rejection reason describes a content mismatch, or
    // (b) when the content scan DOES match, the orchestrator's regex-bound
    // schema check rejects with a fixed reason that doesn't embed the
    // malicious value. In both branches the malicious bytes never reach
    // the GITHUB_OUTPUT key=value boundary.
    const fixture = setupFixture();
    try {
      const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
      writeTrustedReviewersYaml(fixture.root, publicKeyPem);
      writeAttestation(
        fixture.root,
        fixture.headSha,
        fixture.baseSha,
        fixture.headSha,
        privateKeyPem,
      );
      const envPath = join(
        fixture.root,
        '.ai-sdlc',
        'attestations',
        `${fixture.headSha}.dsse.json`,
      );
      const envelope = JSON.parse(readFileSync(envPath, 'utf-8'));
      const predicate = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8'));
      predicate.subject.digest.sha1 = 'a'.repeat(40) + '\nstatus=valid';
      envelope.payload = Buffer.from(JSON.stringify(predicate), 'utf-8').toString('base64');
      writeFileSync(envPath, JSON.stringify(envelope, null, 2));

      const out = runVerifier({
        headSha: fixture.headSha,
        baseSha: fixture.baseSha,
        repoRoot: fixture.root,
      });
      assert.equal(out.status, 'invalid');
      // The malicious value must NOT appear in the reason string regardless
      // of which rejection branch we land in.
      assert.equal(out.reason.includes('status=valid'), false);
      assert.equal(out.reason.includes('\n'), false);
      assert.equal(out.reason.includes('\r'), false);

      // And when we feed THIS reason through the writer, the structure
      // is still safe (statuses=1 outside heredoc, reason in heredoc).
      const lines = buildGithubOutputLines(out.status, out.reason).split('\n');
      const openIdx = lines.findIndex((l) => /^reason<<EOF_[0-9a-f]{64}$/.test(l));
      const delim = lines[openIdx].slice('reason<<'.length);
      const closeIdx = lines.findIndex((l, i) => i > openIdx && l === delim);
      const outsideHeredoc = [...lines.slice(0, openIdx), ...lines.slice(closeIdx)];
      const statuses = outsideHeredoc.filter((l) => /^status=/.test(l));
      assert.equal(statuses.length, 1);
      assert.equal(statuses[0], 'status=invalid');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
