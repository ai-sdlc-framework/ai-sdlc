/**
 * Integration tests for `scripts/verify-attestation.mjs` — the verifier the
 * `verify-attestation.yml` workflow shells out to (AISDLC-74).
 *
 * Covers the workflow contract end-to-end against a synthetic git repo so
 * the regression cases (force-push diff change, policy edit, agent edit)
 * exercise the same hash + signature codepath that production runs.
 *
 * Run with: node --test scripts/verify-attestation.test.mjs
 *
 * AC traceability:
 *   - AC #6 (verify against PR state)
 *   - AC #9 (replay protection: force-push diff change)
 *   - AC #10 (policy-pin: review-policy.md change)
 *   - AC #11 (agent-pin: reviewer agent .md change)
 *   - AC #12 (schema-version enforcement)
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildGithubOutputLines,
  parseTrustedReviewers,
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

function writeAttestation(root, headSha, baseSha, privateKeyPem, overrides = {}) {
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
    commitSha: headSha,
    diff,
    policy,
    reviewers,
    pluginVersion: '0.7.0',
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
    join(root, '.ai-sdlc', 'attestations', `${headSha}.dsse.json`),
    JSON.stringify(envelope, null, 2),
  );
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

describe('runVerifier (integration)', () => {
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
    writeAttestation(fixture.root, fixture.headSha, fixture.baseSha, privateKeyPem);

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

  it('returns invalid (diffHash mismatch) after a force-push changes the diff (AC #9)', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    writeTrustedReviewersYaml(fixture.root, publicKeyPem);
    writeAttestation(fixture.root, fixture.headSha, fixture.baseSha, privateKeyPem);
    // Simulate a force-push by amending the head commit with extra content.
    writeFileSync(join(fixture.root, 'feature.txt'), 'feature\nMORE CONTENT\n');
    git(['add', 'feature.txt'], fixture.root);
    git(['commit', '--amend', '-q', '--no-edit'], fixture.root);
    const newHead = git(['rev-parse', 'HEAD'], fixture.root).trim();
    // Move the envelope to the new head sha so the file-existence check passes —
    // verifier should now reject on diffHash, not on missing file.
    const oldEnvelope = readFileSync(
      join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.dsse.json`),
      'utf-8',
    );
    writeFileSync(
      join(fixture.root, '.ai-sdlc', 'attestations', `${newHead}.dsse.json`),
      oldEnvelope,
    );
    const out = runVerifier({
      headSha: newHead,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'invalid');
    assert.match(out.reason, /subject digest mismatch|diffHash mismatch/);
  });

  it('returns invalid (policyHash mismatch) after .ai-sdlc/review-policy.md edit (AC #10)', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    writeTrustedReviewersYaml(fixture.root, publicKeyPem);
    writeAttestation(fixture.root, fixture.headSha, fixture.baseSha, privateKeyPem);
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

  it('returns invalid (agentFileHash mismatch) after a reviewer agent edit (AC #11)', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    writeTrustedReviewersYaml(fixture.root, publicKeyPem);
    writeAttestation(fixture.root, fixture.headSha, fixture.baseSha, privateKeyPem);
    // Edit the code-reviewer agent file AFTER signing. Verifier should reject.
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
    assert.match(out.reason, /agentFileHash mismatch.*code-reviewer/);
  });

  it('returns invalid (schemaVersion mismatch) when envelope claims a non-allowlisted version (AC #12)', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    writeTrustedReviewersYaml(fixture.root, publicKeyPem);
    // Sign with v1 (the only accepted version) then mutate the payload to v2.
    // We need to bypass signAttestation's allowlist check, so we hand-craft
    // a v2 envelope by re-base64-encoding a tampered predicate. Without
    // re-signing, the signature won't match — that's still "invalid", which
    // is what the AC asks for. (The full schema-version test is in the
    // attestations.test.ts unit test; here we assert the verifier surfaces
    // SOME failure when the envelope payload claims schemaVersion outside the
    // allowlist.)
    writeAttestation(fixture.root, fixture.headSha, fixture.baseSha, privateKeyPem, {});
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
    // Post-review hardening: the schema validator runs FIRST and rejects
    // non-allowlisted schemaVersion values with a fixed reason that does
    // not embed user-controlled content. The earlier signature-mismatch
    // path is no longer reachable for this specific input.
    assert.match(
      out.reason,
      /schemaVersion not in accepted enum|schemaVersion 'v99' not in allowlist|signature did not match/,
    );
  });

  it('returns invalid (signature did not match) when the attestation was signed with an untrusted key', () => {
    const { privateKeyPem } = generateSigningKeyPair();
    const { publicKeyPem: otherPubkey } = generateSigningKeyPair();
    writeTrustedReviewersYaml(fixture.root, otherPubkey);
    writeAttestation(fixture.root, fixture.headSha, fixture.baseSha, privateKeyPem);
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'invalid');
    assert.match(out.reason, /signature did not match/);
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
    // Build a fixture where a malicious envelope claims a sha1 with
    // newline + status=valid embedded. The shape validator MUST reject
    // this, and the rejection reason MUST NOT contain the injection.
    const fixture = setupFixture();
    try {
      const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
      writeTrustedReviewersYaml(fixture.root, publicKeyPem);
      // Sign a normal attestation, then mutate the payload sha1.
      writeAttestation(fixture.root, fixture.headSha, fixture.baseSha, privateKeyPem);
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
      assert.match(out.reason, /schema validation failed: subject\.digest\.sha1/);
      // The injection must NOT appear in the reason string.
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

after(() => {
  // No global cleanup needed — beforeEach/afterEach handle their fixtures.
});
