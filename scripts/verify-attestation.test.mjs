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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync as spawnSyncNode } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildGithubOutputLines,
  detectOrphanEnvelopes,
  detectQueueRebaseInvalidation,
  findChoreCommitViolations,
  isAttestationOnlyDescendant,
  isCiOnlyKey,
  loadAllAttestations,
  parseTrustedReviewers,
  partitionTrustedReviewers,
  predicateMatchReason,
  resolveAncestorDepth,
  resolveSubjectShaForEnvelope,
  runVerifier,
  v6HashLeaf,
  v6ComputeMerkleRoot,
  v6VerifyInclusion,
  v6LoadLeaves,
  verifyV6Envelope,
  DEFAULT_VERIFIER_SCAN_BUDGET_MS,
  describeRequiredReviewerSet,
  resolveScanBudgetMs,
  resolveScanMaxCandidates,
  computePatchIdForVerifier,
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
  // AISDLC-862: reuse the built dist; never build inside a test.
  if (!existsSync(orchestratorBarrel)) {
    throw new Error(
      'precondition: orchestrator/dist is not built (missing orchestrator/dist/runtime/attestations.js); ' +
        'run `pnpm --filter @ai-sdlc/orchestrator build` first. Tests never build it (AISDLC-862).',
    );
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
  // AISDLC-252: codex variants are also read by the verifier.
  'code-reviewer-codex': '---\nname: code-reviewer-codex\n---\nbody1-codex\n',
  'test-reviewer': '---\nname: test-reviewer\n---\nbody2\n',
  'test-reviewer-codex': '---\nname: test-reviewer-codex\n---\nbody2-codex\n',
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

// AISDLC-103: the legacy `collectChangedFileEntries` helper (which mirrored
// AISDLC-94's contentHash producer) was deleted along with the contentHash
// dual-hash leg. Only `collectChangedFileDeltaEntries` (the v3 producer)
// remains.

/**
 * Walk merge-base + per-file (base, head) blob-pair lookups for the given
 * range and return the entries `computeContentHashV3` expects. Mirrors the
 * production `collectChangedFileDeltaEntries` so test attestations carry
 * the same `contentHashV3` shape (AISDLC-101 / AISDLC-103).
 */
function collectChangedFileDeltaEntries(root, baseRef, headRef) {
  const mergeBase = git(['merge-base', baseRef, headRef], root).trim();
  const nameOnly = git(['diff', '--name-only', '--no-renames', `${baseRef}...${headRef}`], root);
  const paths = nameOnly.split('\n').filter((p) => p.length > 0);
  const lookupBlob = (ref, path) => {
    try {
      const lsOut = git(['ls-tree', '-r', ref, '--', path], root);
      const line = lsOut.split('\n').find((l) => l.length > 0);
      if (line) {
        const m = line.match(/^[0-9]+\s+blob\s+([0-9a-f]{40})\t/);
        if (m) return m[1];
      }
    } catch {
      // missing at ref → empty
    }
    return '';
  };
  return paths.map((p) => ({
    path: p,
    baseBlobSha: lookupBlob(mergeBase, p),
    headBlobSha: lookupBlob(headRef, p),
  }));
}

function writeAttestation(root, subjectSha, baseSha, headSha, privateKeyPem, overrides = {}) {
  void headSha; // unused after AISDLC-103 (no diff text bound anymore)
  const policy = readFileSync(join(root, '.ai-sdlc', 'review-policy.md'), 'utf-8');
  const reviewers = Object.entries(AGENT_FILES).map(([agentId, content]) => ({
    agentId,
    agentFileContent: content,
    harness: 'codex',
    approved: true,
    findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
  }));
  // AISDLC-103: v3-only — collect per-file (base, head) blob deltas
  // against the SUBJECT sha (= what the dev commit attested). Callers
  // can override via `overrides.changedFileDeltas` to test specific
  // shapes (e.g. an empty no-op PR).
  const changedFileDeltas =
    overrides.changedFileDeltas !== undefined
      ? overrides.changedFileDeltas
      : collectChangedFileDeltaEntries(root, baseSha, subjectSha);
  const predicate = buildPredicate({
    commitSha: subjectSha,
    policy,
    reviewers,
    pluginVersion: PLUGIN_VERSION,
    iterationCount: 1,
    harnessNote: '',
    signedAt: '2026-04-27T00:00:00.000Z',
    changedFileDeltas,
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

  it('parses an optional unquoted ciOnly: true scalar (AISDLC-593)', () => {
    const yaml = `reviewers:
  - identity: 'ci@ai-sdlc.io'
    machine: 'gha-runner'
    addedAt: '2026-09-06'
    addedBy: 'deefactorial'
    ciOnly: true
    pubkey: |
      -----BEGIN PUBLIC KEY-----
      CCC
      -----END PUBLIC KEY-----
`;
    const { reviewers } = parseTrustedReviewers(yaml);
    assert.equal(reviewers.length, 1);
    assert.equal(reviewers[0].ciOnly, 'true');
  });

  it('leaves ciOnly unset for a plain entry (AISDLC-593)', () => {
    const yaml = `reviewers:
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
    assert.equal(reviewers[0].ciOnly, undefined);
  });
});

describe('partitionTrustedReviewers / isCiOnlyKey (AISDLC-593, RFC-0047 Phase 1)', () => {
  const OPERATOR_PEM = '-----BEGIN PUBLIC KEY-----\nOPERATOR\n-----END PUBLIC KEY-----\n';
  const CI_ONLY_PEM = '-----BEGIN PUBLIC KEY-----\nCIONLY\n-----END PUBLIC KEY-----\n';

  const trustedReviewers = [
    {
      identity: 'operator@example.com',
      machine: 'laptop',
      pubkey: OPERATOR_PEM,
      addedAt: '2026-04-27',
      addedBy: 'maintainer',
    },
    {
      identity: 'ci@ai-sdlc.io',
      machine: 'gha-runner',
      pubkey: CI_ONLY_PEM,
      addedAt: '2026-09-06',
      addedBy: 'deefactorial',
      ciOnly: true,
    },
  ];

  it('a ciOnly entry lands in the ci-only set; a plain entry does not', () => {
    const { operatorKeys, ciOnlyKeys } = partitionTrustedReviewers(trustedReviewers);
    assert.equal(operatorKeys.length, 1);
    assert.equal(operatorKeys[0].identity, 'operator@example.com');
    assert.equal(ciOnlyKeys.length, 1);
    assert.equal(ciOnlyKeys[0].identity, 'ci@ai-sdlc.io');
  });

  it('treats ciOnly: false explicitly the same as absent', () => {
    const { operatorKeys, ciOnlyKeys } = partitionTrustedReviewers([
      { ...trustedReviewers[0], ciOnly: false },
    ]);
    assert.equal(operatorKeys.length, 1);
    assert.equal(ciOnlyKeys.length, 0);
  });

  it('returns empty partitions for an empty/undefined list', () => {
    assert.deepEqual(partitionTrustedReviewers([]), { operatorKeys: [], ciOnlyKeys: [] });
    assert.deepEqual(partitionTrustedReviewers(undefined), { operatorKeys: [], ciOnlyKeys: [] });
  });

  it('isCiOnlyKey is true for a ci-only pubkey and false for an operator pubkey', () => {
    assert.equal(isCiOnlyKey(CI_ONLY_PEM, trustedReviewers), true);
    assert.equal(isCiOnlyKey(OPERATOR_PEM, trustedReviewers), false);
  });

  it('isCiOnlyKey is false for an unknown or empty pubkey', () => {
    assert.equal(
      isCiOnlyKey(
        '-----BEGIN PUBLIC KEY-----\nUNKNOWN\n-----END PUBLIC KEY-----\n',
        trustedReviewers,
      ),
      false,
    );
    assert.equal(isCiOnlyKey('', trustedReviewers), false);
    assert.equal(isCiOnlyKey(undefined, trustedReviewers), false);
  });

  it('AISDLC-595 carry-forward guard: throws on unvalidated raw-parser ciOnly (string, not boolean)', () => {
    // Raw parseTrustedReviewers() output carries the YAML scalar as the
    // STRING 'true', not a boolean — partitionTrustedReviewers must refuse
    // this input rather than silently (if safely) misclassifying it as an
    // operator key.
    assert.throws(
      () => partitionTrustedReviewers([{ ...trustedReviewers[1], ciOnly: 'true' }]),
      /non-boolean ciOnly/,
    );
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

  it('AISDLC-207 AC1: returns "no envelope present at <head>" when no envelope file exists', () => {
    // Pre-AISDLC-207 the verifier surfaced `contentHashV3 mismatch (PR
    // content differs from attested content)` for this branch even though
    // there was nothing on disk to mismatch against — observed on PR #338
    // and confused the operator into thinking the v4-prefer logic was
    // broken. The new wording calls out the actual failure mode and
    // includes the short HEAD SHA so an operator can tell at a glance
    // which commit is missing an envelope.
    const { publicKeyPem } = generateSigningKeyPair();
    writeTrustedReviewersYaml(fixture.root, publicKeyPem);
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'invalid');
    assert.match(out.reason, /no envelope present at [0-9a-f]{7}/);
    // Must NOT default to the misleading legacy v3-mismatch wording.
    assert.equal(
      out.reason.includes('contentHashV3 mismatch'),
      false,
      `AISDLC-207: no-envelope case must not surface contentHashV3 wording, got: ${out.reason}`,
    );
    assert.equal(
      out.reason.includes('contentHashV4 mismatch'),
      false,
      `AISDLC-207: no-envelope case must not surface contentHashV4 wording, got: ${out.reason}`,
    );
  });
});

// ─── AISDLC-583 — consumer-repo agent-dir resolution ────────────────
//
// `runVerifier` previously read reviewer agent-definition files from a
// MONOREPO-ONLY path (`<repoRoot>/ai-sdlc-plugin/agents/*.md`), unguarded.
// In a consumer/adopter repo that path never exists (the plugin is an
// npm/marketplace install, never checked into the repo tree), so the read
// threw ENOENT during verifier SETUP — before any envelope was evaluated —
// making `verify-attestation` fail closed on 100% of adopter PRs. The fix
// adds a driver-injectable `agentDir` (mirroring the `bindRuntime()`
// injection pattern, AISDLC-566) with a three-tier fallback: injected dir →
// repo-relative monorepo path → guarded, warned downgrade (never a throw).

// ─── AISDLC-84 — rebase-stable matching ─────────────────────────────
//
// The whole point of AISDLC-84: SHA can change for non-content reasons
// (rebase, amend, force-push of a no-op edit) and the verifier must still
// accept the existing attestation as long as the CONTENT bindings still
// match current PR state.

// ─── AISDLC-85 — chore-commit-on-top fix ────────────────────────────
//
// The standard `/ai-sdlc execute` shape signs at the dev commit's HEAD
// THEN adds a chore commit (file move + attestation file) on top. AISDLC-84
// computed diffHash from PR HEAD's diff, which included the chore commit,
// so the attestation never verified. AISDLC-85 recomputes diffHash from
// each envelope's `subject.digest.sha1` (the dev commit's SHA at sign time)
// and gates on a chore-commit allowlist to prevent malicious chore commits.

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

describe('resolveSubjectShaForEnvelope (AISDLC-85 / AISDLC-103)', () => {
  it('returns null when predicate.contentHashV3 is missing', () => {
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

  it('returns null when no ancestor contentHashV3 matches', () => {
    // Stub git: merge-base says not-an-ancestor for the subject SHA, then
    // rev-list returns one ancestor commit; merge-base for that ancestor
    // returns a fake SHA so the v3 recompute proceeds; diff returns no
    // changed files so v3 recomputes to sha256('') which won't match
    // the bogus expected.
    const fakeGit = (args) => {
      // skip the leading -c core.quotepath=false flags from the real git wrapper
      const trim = args.filter((a) => a !== '-c' && a !== 'core.quotepath=false');
      const cmd = trim[0];
      if (cmd === 'merge-base' && trim[1] === '--is-ancestor') {
        const err = new Error('not an ancestor');
        err.status = 1;
        throw err;
      }
      if (cmd === 'merge-base') return 'e'.repeat(40) + '\n';
      if (cmd === 'rev-list') return 'b'.repeat(40) + '\n';
      if (cmd === 'diff') return ''; // no changed files
      if (cmd === 'ls-tree') return '';
      return '';
    };
    const r = resolveSubjectShaForEnvelope({
      envelope: { payload: 'x' },
      predicate: {
        contentHashV3: '0'.repeat(64), // bogus expected — won't match sha256('')
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
describe('predicateMatchReason (AISDLC-103)', () => {
  function baseExpected() {
    return {
      contentHashV3: 'a'.repeat(64),
      policyHash: 'b'.repeat(64),
      expectedAgentFileHashes: { 'code-reviewer': 'c'.repeat(64) },
      pluginVersion: '0.7.1',
      acceptedSchemaVersions: ['v3'],
    };
  }
  function basePredicate() {
    return {
      schemaVersion: 'v3',
      contentHashV3: 'a'.repeat(64),
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

  it('returns contentHashV3 mismatch when content differs', () => {
    const r = predicateMatchReason(
      { ...basePredicate(), contentHashV3: 'x'.repeat(64) },
      baseExpected(),
    );
    assert.equal(r.field, 'contentHashV3');
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

// ─── AISDLC-94 — rebase-tolerant contentHash dual-hash mode ──────────
//
// The headline regression: PR-X is signed at base B1. Sibling PR-Y
// (touching the same files) merges into main, becoming part of B2. PR-X
// gets rebased onto B2 — clean, no conflicts, file content unchanged in
// PR-X's altered files. But `git diff B2...PR-X` produces different
// TEXT than `git diff B1...PR-X` did at sign time (different `@@` hunk
// headers, shifted context lines), so `diffHash` diverges.
//
// AISDLC-93/PR #102 hit exactly this when AISDLC-90/PR #101 merged
// first. The Phase 1 fix: dual-hash envelopes carry `contentHash`
// (sha256 of {path, blobSha} for each changed file at HEAD) alongside
// `diffHash`. The verifier accepts on contentHash even when diffHash
// diverges — file blob SHAs are content-addressed and survive rebases
// that don't conflict.

// ─── AISDLC-101 — per-file-delta contentHashV3 (Phase 2 triple-hash) ─
//
// Phase 2 of the AISDLC-94 dual-hash → triple-hash migration. Adds a third
// content binding `contentHashV3` over per-file `(base_blob_sha,
// head_blob_sha)` transitions. The verifier OR's all three legs (v1
// diffHash, v2 contentHash, v3 contentHashV3) — any single matching leg
// is enough.
//
// The headline regression case driving Phase 2 is AISDLC-93 / PR #102:
// when a sibling PR landed on main and modified the same file as PR-X
// between OUR sign + OUR merge, the rebased PR-X HEAD blob now contains
// the sibling's contributions → v2 contentHash diverges (the post-apply
// blob SHA changed). v3 commits to the (base, head) transition, which
// also changes when the base shifts — so v3 alone doesn't fully solve
// the sibling-overlap case in isolation, but PROVIDES a stricter
// "post-apply only" delta binding that complements the producer-side
// pre-sign rebase from AISDLC-102. The 3-layer combination handles the
// real-world sibling-overlap reliably.

describe('runVerifier (AISDLC-101 — triple-hash with per-file-delta contentHashV3)', () => {
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

  // AISDLC-103 INVERSION of the legacy AISDLC-101 "Phase-1 envelope still
  // verifies via the dual-hash leg" test. The dual-hash window is gone:
  // a Phase-1 envelope (= no contentHashV3) is now rejected with the
  // schemaVersion-allowlist reason because writeAttestation can no longer
  // produce a "v1" envelope through the public API. We hand-craft the
  // legacy shape to assert the reject path.
  it('AISDLC-103: Phase-1 envelope (schemaVersion v1, no contentHashV3) is now REJECTED', () => {
    // Hand-craft a v1-shaped envelope on disk. The script's verifier
    // matches by predicate-content scan, so the schema validator runs
    // FIRST and rejects on schemaVersion not in [v3].
    const headSha = fixture.headSha;
    const legacyPredicate = {
      schemaVersion: 'v1',
      subject: { digest: { sha1: headSha } },
      diffHash: 'a'.repeat(64),
      policyHash: 'b'.repeat(64),
      reviewers: [
        {
          agentId: 'code-reviewer',
          agentFileHash: 'c'.repeat(64),
          harness: 'codex',
          approved: true,
          findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        },
        {
          agentId: 'test-reviewer',
          agentFileHash: 'd'.repeat(64),
          harness: 'codex',
          approved: true,
          findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        },
        {
          agentId: 'security-reviewer',
          agentFileHash: 'e'.repeat(64),
          harness: 'codex',
          approved: true,
          findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        },
      ],
      pluginVersion: PLUGIN_VERSION,
      iterationCount: 1,
      harnessNote: '',
      signedAt: '2026-04-27T00:00:00.000Z',
    };
    const payloadJson = Buffer.from(JSON.stringify(legacyPredicate), 'utf-8');
    const envelope = {
      payloadType: 'application/vnd.ai-sdlc.attestation+json',
      payload: payloadJson.toString('base64'),
      signatures: [{ keyid: 'maintainer:laptop', sig: Buffer.alloc(64).toString('base64') }],
    };
    writeFileSync(
      join(fixture.root, '.ai-sdlc', 'attestations', `${headSha}.dsse.json`),
      JSON.stringify(envelope, null, 2),
    );

    const out = runVerifier({
      headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(
      out.status,
      'invalid',
      `Phase-1 envelope must be REJECTED, got: ${out.status} (${out.reason})`,
    );
    assert.match(out.reason, /schemaVersion 'v1' not in allowlist|schemaVersion not in/);
  });
});

// ─── AISDLC-100.6 — pipelineVersion forensic logging (RFC-0012 Phase 6) ──
//
// The verifier reads `predicate.pipelineVersion` from the matched envelope
// and emits a single info-level log line. It is NOT enforced — the verdict
// stays `valid` regardless of which version (or no version) is present.
// These tests exercise both shapes (with + without) end-to-end through
// `runVerifier` against synthetic git fixtures, matching the rest of the
// AISDLC-94/-101 hash-leg tests in this file.

// ─── AISDLC-207 — distinguish verifier failure modes in `reason` ──────
//
// Background: pre-AISDLC-207 the `reason` returned by `runVerifier` (which
// the verify-attestation.yml workflow embeds verbatim into the
// `ai-sdlc/attestation` GitHub status description) defaulted to
// `contentHashV3 mismatch (PR content differs from attested content)` for
// nearly every failure mode — including the no-envelope-on-disk case where
// there's no v3 hash to mismatch against. This produced misleading
// descriptions on PR #338: an operator who hadn't signed at all saw "v3
// mismatch" and reasonably wondered whether the v4-prefer logic from
// AISDLC-193.1 was misbehaving.
//
// AISDLC-207 surfaces the specific failure mode in `reason` so the
// description is self-explanatory:
//   AC1 — `no envelope present at <head>` (no envelope file on disk)
//   AC2 — `contentHashV4 mismatch` (envelope present + v4 mismatch)
//   AC3 — `contentHashV3 mismatch (v3 fallback)` (legacy v3-only env mismatch)
//   AC4 — `signature invalid: <reason>` (signature verification failed)
//
// Each AC has a dedicated test below. AC1 is also covered by the
// modified `returns invalid (...)` test in the happy-path block above.
// ─── AISDLC-237 — contentHashV4 merge-queue rebase stability ──────────────
//
// Root-cause analysis (AC#3): contentHashV4 IS base-independent for
// non-overlapping PRs. The design intent — "survives merge-queue rebases" —
// holds exactly when the PR's files don't overlap with sibling PRs that land
// between signing and queue admission. When a sibling PR DID modify the same
// files, v4 correctly rejects because the file content at the merge_group
// commit genuinely includes both PRs' changes — this is not a bug.
//
// The CLAUDE.md description "survives merge-queue rebases" was imprecise.
// It has been amended to "survives merge-queue rebases when the PR's files
// don't overlap with sibling PRs; fails (correctly) when a sibling PR
// modified the same files — the reviewed content genuinely changed."
//
// These regression tests pin the correct behavior for both scenarios so a
// future change that breaks v4 stability or incorrectly accepts stale
// same-file envelopes is caught before merge.

// ── AISDLC-258 — verifier honors CONTENTHASHV4_IGNORE_FILES ──────────────
//
// Test-reviewer MAJOR finding: the signer-side IGNORE list is unit-tested in
// orchestrator/src/runtime/attestations.test.ts, but the verifier path
// (computeHeadContentHashV4 here) reads the same constant and must produce
// the SAME hash for the contract to hold across rebases. This describe block
// asserts the verifier-side behavior end-to-end: sign at HEAD, modify only
// an IGNORE-list file (pnpm-lock.yaml), re-run the verifier, expect VALID.

// ─── AISDLC-274 — orphan-envelope detection ──────────────────────────
//
// When a PR is queue-rebased and re-signed multiple times, stale envelope
// files accumulate. The verifier must detect these orphans and surface an
// actionable error message instead of falling through to a misleading
// `contentHashV4 mismatch`.

describe('detectOrphanEnvelopes (AISDLC-274)', () => {
  let fixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('returns empty orphans when there are no PR-added envelopes', () => {
    const { orphans, total } = detectOrphanEnvelopes(
      fixture.headSha,
      fixture.baseSha,
      fixture.root,
    );
    assert.equal(orphans.length, 0, 'no PR-added envelopes should yield no orphans');
    assert.equal(total, 0);
  });

  it('detects an envelope whose filename SHA is not a valid git object (orphan)', () => {
    // Create an envelope file with a SHA that doesn't exist in the repo.
    const fakeSha = '0000000000000000000000000000000000000001';
    const attDir = join(fixture.root, '.ai-sdlc', 'attestations');
    mkdirSync(attDir, { recursive: true });
    const fakeEnvPath = join(attDir, `${fakeSha}.dsse.json`);
    writeFileSync(fakeEnvPath, '{"_test":"orphan"}\n');
    // Stage + commit so git diff sees it as PR-added.
    git(['add', '.'], fixture.root);
    git(['commit', '-q', '-m', 'chore: stale envelope from old sign'], fixture.root);
    const newHead = git(['rev-parse', 'HEAD'], fixture.root).trim();

    const { orphans, total } = detectOrphanEnvelopes(newHead, fixture.baseSha, fixture.root);
    assert.equal(orphans.length, 1, `expected 1 orphan, got: ${orphans.join(', ')}`);
    assert.ok(orphans[0].includes(fakeSha), `orphan path must include the fake SHA: ${orphans[0]}`);
    assert.equal(total, 1);
  });
});

// ─── AISDLC-369 — contentHashV5 merge-queue rebase stability ──────────────
//
// V5 was designed to survive sibling-PR merges by freezing the diff base at
// signedMergeBase (computed once at sign time). The verifier reproduces the
// diff using the SAME frozen SHA, so non-overlapping sibling merges don't
// change the file enumeration → v5 hash stays stable → no re-sign needed.
//
// These tests pin the two canonical scenarios:
//   1. Non-overlapping sibling: v5 survives the merge-queue rebase.
//   2. Overlapping sibling (same file): v5 correctly rejects (content changed).

// ─── AISDLC-360 — queue-rebase invalidation HINT ─────────────────────────────
//
// When an overlapping-sibling merge invalidates the v5/v4 hash at the merge
// queue's probe SHA, the verifier emits a stderr HINT line telling the
// operator the recovery action (`/ai-sdlc rebase <pr>`). The HINT must fire
// EXACTLY in the queue-rebase-invalidated case — not on local tampering,
// not on a never-signed envelope, not on a missing envelope.
//
// We exercise the helper directly (detectQueueRebaseInvalidation) for the
// canonical positive case + a couple of negative cases. The full runVerifier
// integration is implicitly exercised by the overlapping-sibling test in
// the AISDLC-369 block above (which produces the contentHashV5 mismatch
// state this helper consumes).

// ─── AISDLC-383.4 — v6 Merkle attestation verifier ───────────────────────────
//
// Hermetic tests for the RFC-0042 Phase 2 v6 verifier. Tests use in-process
// key generation (Node crypto) and avoid git operations — all Merkle and
// signature verification is pure-function.
//
// AC traceability:
//   AC#1 — v6 happy path (valid envelope + valid leaves + valid signature)
//   AC#2 — 4 rejection paths: bad signature, invalid Merkle proof, tampered leaf, wrong nonce format
//   AC#3 — legacy v5/v4/v3 fallback when no v6 envelope present (covered via runVerifier)
//   AC#5 — mixed-version: v6 envelope present → prefers v6, ignores legacy
//   AC#6 — soft-fail when transcript-leaves.jsonl is missing (OQ-3)

import { generateKeyPairSync, sign as cryptoSignNode } from 'node:crypto';

/** Generate an ed25519 keypair (PEM strings) for v6 test fixtures. */
function genV6KeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

/** Sign a rootHash string with an ed25519 private key. Returns base64. */
function signV6Root(rootHash, privateKeyPem) {
  const sig = cryptoSignNode(null, Buffer.from(rootHash, 'utf8'), privateKeyPem);
  return sig.toString('base64');
}

/**
 * Build a minimal TranscriptLeaf for tests.
 */
function makeLeaf(leafIndex, reviewerName, transcriptHash) {
  return {
    leafIndex,
    taskId: 'AISDLC-TEST',
    reviewerName,
    transcriptHash: transcriptHash ?? 'a'.repeat(64),
    nonce: 'b'.repeat(64),
    harness: 'claude-code',
    model: 'sonnet',
    verdictApproved: true,
    findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    signedAt: '2026-05-21T00:00:00.000Z',
  };
}

/**
 * Build a well-formed v6 envelope from leaves.
 * Uses the real Merkle computation + ed25519 signing.
 */
function buildValidV6Envelope(headSha, leaves, privateKeyPem, overrides = {}) {
  const { root: rootHash, proofs } = v6ComputeMerkleRoot(leaves);
  const rootSignature = signV6Root(rootHash, privateKeyPem);

  const transcriptLeaves = leaves.map((l, i) => ({
    leafIndex: l.leafIndex,
    reviewerName: l.reviewerName,
    transcriptHash: l.transcriptHash,
  }));
  const merkleProofs = leaves.map((l, i) => ({
    leafIndex: l.leafIndex,
    proof: proofs[i] ?? [],
  }));

  return {
    schemaVersion: 'v6',
    subject: { digest: { sha1: headSha } },
    transcriptLeaves,
    merkleProofs,
    rootHash,
    rootSignature,
    nonce: 'c'.repeat(64),
    leafCount: leaves.length,
    signedAt: '2026-05-21T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Write a v6 envelope to disk and transcript-leaves.jsonl.
 */
function writeV6Fixture(root, headSha, leaves, privateKeyPem, envelopeOverrides = {}) {
  // Ensure directories exist.
  mkdirSync(join(root, '.ai-sdlc', 'attestations'), { recursive: true });

  // Write transcript-leaves.jsonl
  const leavesContent = leaves.map((l) => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(join(root, '.ai-sdlc', 'transcript-leaves.jsonl'), leavesContent);

  // Build and write v6 envelope
  const envelope = buildValidV6Envelope(headSha, leaves, privateKeyPem, envelopeOverrides);
  const envPath = join(root, '.ai-sdlc', 'attestations', `${headSha}.v6.dsse.json`);
  writeFileSync(envPath, JSON.stringify(envelope, null, 2) + '\n');
  return { envelope, envPath };
}

describe('v6 Merkle primitives', () => {
  it('v6HashLeaf produces a 64-char hex string', () => {
    const leaf = makeLeaf(0, 'code-reviewer');
    const hash = v6HashLeaf(leaf);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('v6HashLeaf is deterministic (same input → same output)', () => {
    const leaf = makeLeaf(0, 'code-reviewer');
    assert.equal(v6HashLeaf(leaf), v6HashLeaf(leaf));
  });

  it('v6HashLeaf differs when leafIndex differs', () => {
    const l1 = makeLeaf(0, 'code-reviewer');
    const l2 = makeLeaf(1, 'code-reviewer');
    assert.notEqual(v6HashLeaf(l1), v6HashLeaf(l2));
  });

  it('v6ComputeMerkleRoot returns empty root for empty leaves', () => {
    const { root } = v6ComputeMerkleRoot([]);
    assert.equal(root, '');
  });

  it('v6ComputeMerkleRoot returns leaf hash as root for single leaf', () => {
    const leaf = makeLeaf(0, 'code-reviewer');
    const { root, proofs } = v6ComputeMerkleRoot([leaf]);
    assert.equal(root, v6HashLeaf(leaf));
    assert.deepEqual(proofs[0], []);
  });

  it('v6VerifyInclusion returns true for a valid 3-leaf tree', () => {
    const leaves = [
      makeLeaf(0, 'code-reviewer'),
      makeLeaf(1, 'test-reviewer'),
      makeLeaf(2, 'security-reviewer'),
    ];
    const { root, proofs } = v6ComputeMerkleRoot(leaves);
    for (let i = 0; i < leaves.length; i++) {
      const leafHash = v6HashLeaf(leaves[i]);
      assert.ok(
        v6VerifyInclusion(leafHash, proofs[i], root, i, leaves.length),
        `inclusion proof failed for leaf ${i}`,
      );
    }
  });

  it('v6VerifyInclusion rejects tampered leaf hash', () => {
    const leaves = [makeLeaf(0, 'code-reviewer'), makeLeaf(1, 'test-reviewer')];
    const { root, proofs } = v6ComputeMerkleRoot(leaves);
    const tamperedHash = 'dead'.repeat(16); // 64 hex chars, wrong value
    assert.equal(v6VerifyInclusion(tamperedHash, proofs[0], root, 0, leaves.length), false);
  });

  it('v6VerifyInclusion rejects out-of-bounds leafIndex (CVE-2012-2459)', () => {
    const leaves = [makeLeaf(0, 'code-reviewer'), makeLeaf(1, 'test-reviewer')];
    const { root, proofs } = v6ComputeMerkleRoot(leaves);
    const leafHash = v6HashLeaf(leaves[0]);
    // leafIndex === leafCount is the CVE-2012-2459 boundary condition
    assert.equal(v6VerifyInclusion(leafHash, proofs[0], root, 2, 2), false);
  });

  it('v6LoadLeaves returns empty array when file missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-leaves-test-'));
    try {
      const leaves = v6LoadLeaves(tmp);
      assert.deepEqual(leaves, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('v6LoadLeaves parses well-formed JSONL', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-leaves-test-'));
    try {
      mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
      const leaf = makeLeaf(0, 'code-reviewer');
      writeFileSync(join(tmp, '.ai-sdlc', 'transcript-leaves.jsonl'), JSON.stringify(leaf) + '\n');
      const leaves = v6LoadLeaves(tmp);
      assert.equal(leaves.length, 1);
      assert.equal(leaves[0].leafIndex, 0);
      assert.equal(leaves[0].reviewerName, 'code-reviewer');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('verifyV6Envelope (unit)', () => {
  let keys;
  const HEAD_SHA = 'a'.repeat(40);

  before(() => {
    keys = genV6KeyPair();
  });

  function makeTrustedReviewers(publicKeyPem) {
    return [
      {
        identity: 'test@example.com',
        machine: 'test',
        pubkey: publicKeyPem,
        addedAt: '2026-05-21',
        addedBy: 'test',
      },
    ];
  }

  it('AC#1: verifies a valid v6 envelope with 3 leaves', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-unit-'));
    try {
      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, keys.privateKeyPem);
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'valid', `expected valid, got: ${result.reason}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AC#2a: rejects when rootSignature is from an untrusted key', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-unit-'));
    try {
      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, keys.privateKeyPem);
      const unknownKeys = genV6KeyPair();
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        // Only the unknown key is trusted — signature won't verify
        trustedReviewers: makeTrustedReviewers(unknownKeys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'invalid');
      assert.match(result.reason, /rootSignature did not match any trusted reviewer pubkey/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AC#2b: rejects when Merkle proof is invalid (tampered proof)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-unit-'));
    try {
      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];
      // Build envelope with tampered proof (replace first proof sibling)
      const { root, proofs } = v6ComputeMerkleRoot(leaves);
      const rootSignature = signV6Root(root, keys.privateKeyPem);
      const tamperedProofs = leaves.map((l, i) => ({
        leafIndex: l.leafIndex,
        proof: i === 0 ? ['dead'.repeat(16)] : proofs[i], // tamper proof[0]
      }));
      const envelope = {
        schemaVersion: 'v6',
        subject: { digest: { sha1: HEAD_SHA } },
        transcriptLeaves: leaves.map((l) => ({
          leafIndex: l.leafIndex,
          reviewerName: l.reviewerName,
          transcriptHash: l.transcriptHash,
        })),
        merkleProofs: tamperedProofs,
        rootHash: root,
        rootSignature,
        nonce: 'c'.repeat(64),
        leafCount: leaves.length,
        signedAt: '2026-05-21T00:00:00.000Z',
      };
      const leavesContent = leaves.map((l) => JSON.stringify(l)).join('\n') + '\n';
      mkdirSync(join(tmp, '.ai-sdlc', 'attestations'), { recursive: true });
      writeFileSync(join(tmp, '.ai-sdlc', 'transcript-leaves.jsonl'), leavesContent);
      writeFileSync(
        join(tmp, '.ai-sdlc', 'attestations', `${HEAD_SHA}.v6.dsse.json`),
        JSON.stringify(envelope, null, 2),
      );
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'invalid');
      assert.match(result.reason, /Merkle inclusion proof invalid/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AC#2c: rejects when leaf transcriptHash is tampered', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-unit-'));
    try {
      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, keys.privateKeyPem);
      // Tamper the transcriptHash in the envelope (not on disk — mismatch with on-disk leaf)
      const tamperedEnvelope = {
        ...envelope,
        transcriptLeaves: envelope.transcriptLeaves.map((l, i) =>
          i === 0 ? { ...l, transcriptHash: 'dead'.repeat(16) } : l,
        ),
      };
      const result = verifyV6Envelope({
        envelope: tamperedEnvelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'invalid');
      assert.match(result.reason, /transcriptHash mismatch/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AC#2d: rejects when nonce format is invalid (structural check)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-unit-'));
    try {
      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, keys.privateKeyPem);
      const badNonceEnvelope = { ...envelope, nonce: 'not-a-valid-hex-nonce' };
      const result = verifyV6Envelope({
        envelope: badNonceEnvelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'invalid');
      assert.match(result.reason, /nonce must be a 64-char hex string/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AC#6: CI-mode REJECTS when transcript-leaves.jsonl is missing (replay-attack mitigation per AISDLC-383.4 security review)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-unit-'));
    const prev = process.env['AI_SDLC_V6_SPOT_CHECK_MODE'];
    delete process.env['AI_SDLC_V6_SPOT_CHECK_MODE']; // ensure CI mode
    try {
      // Build envelope but do NOT write transcript-leaves.jsonl
      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];
      const envelope = buildValidV6Envelope(HEAD_SHA, leaves, keys.privateKeyPem);
      mkdirSync(join(tmp, '.ai-sdlc', 'attestations'), { recursive: true });
      writeFileSync(
        join(tmp, '.ai-sdlc', 'attestations', `${HEAD_SHA}.v6.dsse.json`),
        JSON.stringify(envelope, null, 2),
      );
      // No transcript-leaves.jsonl → CI mode must reject (was soft-fail pre-iter-2)
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(
        result.status,
        'invalid',
        `CI mode must reject missing leaves, got: ${result.reason}`,
      );
      // AISDLC-421: error message now mentions both the per-patch-id and
      // shared-fallback paths since the verifier checks both.
      assert.match(result.reason, /no transcript leaves found/);
      assert.match(result.reason, /per-patch-id file/);
      assert.match(result.reason, /shared fallback/);
      assert.match(result.reason, /Replay attack mitigation/);
    } finally {
      if (prev !== undefined) process.env['AI_SDLC_V6_SPOT_CHECK_MODE'] = prev;
      else delete process.env['AI_SDLC_V6_SPOT_CHECK_MODE'];
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AC#6: spot-check mode (AI_SDLC_V6_SPOT_CHECK_MODE=1) opts into soft-fail (OQ-3)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-unit-'));
    const prev = process.env['AI_SDLC_V6_SPOT_CHECK_MODE'];
    process.env['AI_SDLC_V6_SPOT_CHECK_MODE'] = '1';
    try {
      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];
      const envelope = buildValidV6Envelope(HEAD_SHA, leaves, keys.privateKeyPem);
      mkdirSync(join(tmp, '.ai-sdlc', 'attestations'), { recursive: true });
      writeFileSync(
        join(tmp, '.ai-sdlc', 'attestations', `${HEAD_SHA}.v6.dsse.json`),
        JSON.stringify(envelope, null, 2),
      );
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(
        result.status,
        'valid',
        `spot-check mode must return valid, got: ${result.reason}`,
      );
      assert.match(result.reason, /soft-fail/);
    } finally {
      if (prev !== undefined) process.env['AI_SDLC_V6_SPOT_CHECK_MODE'] = prev;
      else delete process.env['AI_SDLC_V6_SPOT_CHECK_MODE'];
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('replay attack: rejects envelope whose subject.digest.sha1 does not match headSha (defence-in-depth)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-unit-'));
    try {
      const leaves = [makeLeaf(0, 'code-reviewer')];
      const STOLEN_SHA = 'a'.repeat(40); // envelope signed for a different PR
      const VICTIM_SHA = 'b'.repeat(40);
      // Build envelope bound to STOLEN_SHA internally but rename file to VICTIM_SHA.
      const envelope = buildValidV6Envelope(STOLEN_SHA, leaves, keys.privateKeyPem);
      mkdirSync(join(tmp, '.ai-sdlc', 'attestations'), { recursive: true });
      writeFileSync(
        join(tmp, '.ai-sdlc', 'attestations', `${VICTIM_SHA}.v6.dsse.json`),
        JSON.stringify(envelope, null, 2),
      );
      // Even with the (matching) leaves file present, the subject mismatch must reject.
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${VICTIM_SHA}.v6.dsse.json`,
        headSha: VICTIM_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'invalid');
      assert.match(result.reason, /subject\.digest\.sha1.*does not match head SHA/);
      // AISDLC-543 / AISDLC-545 AC#4: unreachable subject names the remediation.
      assert.match(result.reason, /unreachable in this clone.*re-sign at HEAD/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('head-sha binding: rejects when filename does not match headSha', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-unit-'));
    try {
      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, keys.privateKeyPem);
      const WRONG_SHA = 'b'.repeat(40);
      const result = verifyV6Envelope({
        envelope,
        // Wrong filename (different SHA) — should reject
        envelopeFileName: `${WRONG_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'invalid');
      assert.match(result.reason, /envelope filename.*does not match expected/i);
      // AISDLC-543 AC#2: states the stale-event-rerun trap + the remediation.
      assert.match(result.reason, /re-run of an older workflow run.*stale/s);
      assert.match(result.reason, /push a fresh synchronize event/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // AISDLC-398 fix #2: v6 verifier rejects patch-id-named envelopes where
  // subject.digest.sha1 doesn't match the actual outer HEAD SHA.
  //
  // This test verifies that the fix to verify-attestation.mjs correctly
  // passes `headSha = lowerHead` (actual CI HEAD) rather than the envelope's
  // own subject SHA, so the binding check is no longer tautological.
  it('AISDLC-398 fix #2: rejects patch-id-named envelope whose subject.digest.sha1 does not match outer headSha', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-unit-398-'));
    try {
      const OUTER_HEAD_SHA = 'f'.repeat(40); // actual current HEAD in CI
      const SIGNED_FOR_SHA = 'e'.repeat(40); // SHA the envelope was actually signed for (different PR)
      const FAKE_PATCH_ID = 'd'.repeat(40);

      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];

      // Build an envelope bound to SIGNED_FOR_SHA (a different PR's HEAD).
      // Attacker renames the file to <patch-id>.v6.dsse.json hoping the
      // tautological check won't catch the mismatch.
      const envelope = buildValidV6Envelope(SIGNED_FOR_SHA, leaves, keys.privateKeyPem);
      mkdirSync(join(tmp, '.ai-sdlc', 'attestations'), { recursive: true });
      writeFileSync(
        join(tmp, '.ai-sdlc', 'attestations', `${FAKE_PATCH_ID}.v6.dsse.json`),
        JSON.stringify(envelope, null, 2) + '\n',
      );

      // Synthesize the envelopeFileName as the caller does after the fix:
      // envelopeFileName = ${envelopeSubjectSha}.v6.dsse.json = ${SIGNED_FOR_SHA}.v6.dsse.json
      // headSha = lowerHead = OUTER_HEAD_SHA
      // The binding check compares: SIGNED_FOR_SHA.v6.dsse.json vs OUTER_HEAD_SHA.v6.dsse.json → REJECT
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${SIGNED_FOR_SHA}.v6.dsse.json`,
        headSha: OUTER_HEAD_SHA, // actual outer PR head (not the envelope's own SHA)
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });

      assert.equal(result.status, 'invalid', `expected invalid, got: ${result.reason}`);
      // The reason should indicate either a filename mismatch OR subject SHA mismatch.
      const isFilenameOrSubjectMismatch =
        /envelope filename.*does not match expected/i.test(result.reason) ||
        /subject\.digest\.sha1.*does not match head SHA/i.test(result.reason);
      assert.ok(
        isFilenameOrSubjectMismatch,
        `expected filename or subject mismatch reason, got: ${result.reason}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── AISDLC-568 — verdictClass (independent / self-authored) ────────────────

describe('verifyV6Envelope (AISDLC-568 — verdictClass)', () => {
  let keys;
  const HEAD_SHA = 'a'.repeat(40);

  before(() => {
    keys = genV6KeyPair();
  });

  function makeTrustedReviewers(publicKeyPem) {
    return [
      {
        identity: 'test@example.com',
        machine: 'test',
        pubkey: publicKeyPem,
        addedAt: '2026-05-21',
        addedBy: 'test',
      },
    ];
  }

  it('(a) independent-reviewer leaf: verifies valid and surfaces independent in the class breakdown', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-verdictclass-'));
    try {
      const leaves = [{ ...makeLeaf(0, 'code-reviewer'), verdictClass: 'independent' }];
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, keys.privateKeyPem, {
        transcriptLeaves: leaves.map((l) => ({
          leafIndex: l.leafIndex,
          reviewerName: l.reviewerName,
          transcriptHash: l.transcriptHash,
          verdictClass: l.verdictClass,
        })),
      });
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'valid', `expected valid, got: ${result.reason}`);
      assert.equal(result.overallVerdictClass, 'independent');
      assert.deepEqual(result.verdictClasses, [
        { reviewerName: 'code-reviewer', verdictClass: 'independent' },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('(b) self-authored (coordinator) leaf: verifies valid but is downgraded to the lower-trust class', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-verdictclass-'));
    try {
      const leaves = [{ ...makeLeaf(0, 'code-reviewer'), verdictClass: 'self-authored' }];
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, keys.privateKeyPem, {
        transcriptLeaves: leaves.map((l) => ({
          leafIndex: l.leafIndex,
          reviewerName: l.reviewerName,
          transcriptHash: l.transcriptHash,
          verdictClass: l.verdictClass,
        })),
      });
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'valid', `expected valid, got: ${result.reason}`);
      assert.equal(result.overallVerdictClass, 'self-authored');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('(c) legacy envelope with no verdictClass anywhere still verifies, defaulting to self-authored', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-verdictclass-legacy-'));
    try {
      // makeLeaf() + writeV6Fixture()'s default transcriptLeaves mapping never
      // set verdictClass — this reproduces a pre-AISDLC-568 envelope exactly.
      const leaves = [makeLeaf(0, 'code-reviewer'), makeLeaf(1, 'test-reviewer')];
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, keys.privateKeyPem);
      assert.equal(envelope.transcriptLeaves[0].verdictClass, undefined);

      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'valid', `expected valid, got: ${result.reason}`);
      assert.equal(result.overallVerdictClass, 'self-authored');
      assert.deepEqual(result.verdictClasses, [
        { reviewerName: 'code-reviewer', verdictClass: 'self-authored' },
        { reviewerName: 'test-reviewer', verdictClass: 'self-authored' },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('(d) mixed leaves: overall verdictClass is self-authored (weakest-link) when any leaf is self-authored', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-verdictclass-mixed-'));
    try {
      const leaves = [
        { ...makeLeaf(0, 'code-reviewer'), verdictClass: 'independent' },
        { ...makeLeaf(1, 'test-reviewer'), verdictClass: 'self-authored' },
      ];
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, keys.privateKeyPem, {
        transcriptLeaves: leaves.map((l) => ({
          leafIndex: l.leafIndex,
          reviewerName: l.reviewerName,
          transcriptHash: l.transcriptHash,
          verdictClass: l.verdictClass,
        })),
      });
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'valid');
      assert.equal(result.overallVerdictClass, 'self-authored');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects when the envelope claims independent but the on-disk leaf is self-authored (tamper detection)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-verdictclass-tamper-'));
    try {
      const leaves = [{ ...makeLeaf(0, 'code-reviewer'), verdictClass: 'self-authored' }];
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, keys.privateKeyPem, {
        transcriptLeaves: leaves.map((l) => ({
          leafIndex: l.leafIndex,
          reviewerName: l.reviewerName,
          transcriptHash: l.transcriptHash,
          // Tampered: envelope claims independent, but the on-disk leaf
          // (whose hash is Merkle-proved) is self-authored.
          verdictClass: 'independent',
        })),
      });
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'invalid');
      assert.match(result.reason, /verdictClass mismatch/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects an envelope with a bogus verdictClass value', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-verdictclass-bogus-'));
    try {
      const leaves = [{ ...makeLeaf(0, 'code-reviewer'), verdictClass: 'independent' }];
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, keys.privateKeyPem, {
        transcriptLeaves: leaves.map((l) => ({
          leafIndex: l.leafIndex,
          reviewerName: l.reviewerName,
          transcriptHash: l.transcriptHash,
          verdictClass: 'trust-me-bro',
        })),
      });
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'invalid');
      assert.match(result.reason, /verdictClass must be/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── RFC-0047 Phase 3 (AISDLC-595) — isolated re-derivation + downgrade ──────
//
// AC traceability:
//   AC#1 — isolated leaf under a ci-only-signed root ⇒ overallIndependenceTier: isolated
//   AC#2 — SECURITY-CRITICAL negative: same leaf/envelope under an OPERATOR-
//          signed root ⇒ downgrades to 'attested' with a recorded reason;
//          status stays 'valid' (does NOT reject)
//   AC#3 — integrity reject: tampered leaf / root sig matching no trusted key
//          still REJECTS (unchanged from pre-existing behaviour)
//   AC#4 — verifier makes zero network calls (asserted via nock-free/offline
//          environment — no fetch/http import anywhere in this module)

describe('verifyV6Envelope (RFC-0047 Phase 3 / AISDLC-595 — isolated re-derivation)', () => {
  let ciOnlyKeys;
  let operatorKeys;
  const HEAD_SHA = 'a'.repeat(40);

  before(() => {
    ciOnlyKeys = genV6KeyPair();
    operatorKeys = genV6KeyPair();
  });

  /** @param {{ciOnly?: true}} [ciKeyOverrides] */
  function makeTrustedReviewers() {
    return [
      {
        identity: 'operator@example.com',
        machine: 'laptop',
        pubkey: operatorKeys.publicKeyPem,
        addedAt: '2026-09-06',
        addedBy: 'maintainer',
      },
      {
        identity: 'ci@ai-sdlc.io',
        machine: 'gha-runner',
        pubkey: ciOnlyKeys.publicKeyPem,
        addedAt: '2026-09-06',
        addedBy: 'deefactorial',
        ciOnly: true,
      },
    ];
  }

  function makeIsolatedLeaf() {
    return { ...makeLeaf(0, 'security-reviewer'), independenceTier: 'isolated' };
  }

  function isolatedTranscriptLeafSummary(leaf) {
    return {
      leafIndex: leaf.leafIndex,
      reviewerName: leaf.reviewerName,
      transcriptHash: leaf.transcriptHash,
      independenceTier: leaf.independenceTier,
    };
  }

  it('AC#1: isolated leaf under a root signed by the ci-only key ⇒ credited as isolated', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-isolated-'));
    try {
      const leaves = [makeIsolatedLeaf()];
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, ciOnlyKeys.privateKeyPem, {
        transcriptLeaves: leaves.map(isolatedTranscriptLeafSummary),
      });
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'valid', `expected valid, got: ${result.reason}`);
      assert.equal(result.overallIndependenceTier, 'isolated');
      assert.deepEqual(result.independenceTiers, [
        { reviewerName: 'security-reviewer', independenceTier: 'isolated' },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AC#2 SECURITY-CRITICAL: the SAME leaf/envelope signed by the OPERATOR key downgrades to attested (still valid, not rejected)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-isolated-downgrade-'));
    try {
      const leaves = [makeIsolatedLeaf()];
      // Same shape as AC#1, but signed with the OPERATOR key — the exact
      // forgery RFC-0047 exists to close: a same-machine coordinator holds
      // only this key, never the ci-only one.
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, operatorKeys.privateKeyPem, {
        transcriptLeaves: leaves.map(isolatedTranscriptLeafSummary),
      });
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(),
        repoRoot: tmp,
      });
      // Load-bearing distinction (OQ-3): integrity is fine (signature DID
      // match a trusted key), so status stays 'valid' — only the tier is
      // downgraded, never a reject.
      assert.equal(
        result.status,
        'valid',
        `expected valid (downgrade, not reject): ${result.reason}`,
      );
      assert.equal(result.overallIndependenceTier, 'attested');
      assert.deepEqual(result.independenceTiers, [
        {
          reviewerName: 'security-reviewer',
          independenceTier: 'attested',
          isolatedDowngraded: { reason: 'no ci-only anchor' },
        },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AC#2b: a mix of one ci-only-anchored isolated leaf and one operator-anchored isolated-declaring leaf still aggregates via weakest-link post-downgrade', () => {
    // Both leaves declare 'isolated' and are committed under the SAME
    // Merkle root / single root signature — so both are anchored (or not)
    // by the SAME signer. This exercises that the per-leaf downgrade
    // correctly feeds the AGGREGATION, not just the per-leaf array.
    const tmp = mkdtempSync(join(tmpdir(), 'v6-isolated-mixed-'));
    try {
      const leaves = [
        { ...makeLeaf(0, 'security-reviewer'), independenceTier: 'isolated' },
        { ...makeLeaf(1, 'code-reviewer'), independenceTier: 'attested' },
      ];
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, operatorKeys.privateKeyPem, {
        transcriptLeaves: leaves.map(isolatedTranscriptLeafSummary),
      });
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'valid', `expected valid: ${result.reason}`);
      // Both leaves resolve to 'attested' post-downgrade → weakest-link 'attested'.
      assert.equal(result.overallIndependenceTier, 'attested');
      assert.deepEqual(result.independenceTiers, [
        {
          reviewerName: 'security-reviewer',
          independenceTier: 'attested',
          isolatedDowngraded: { reason: 'no ci-only anchor' },
        },
        { reviewerName: 'code-reviewer', independenceTier: 'attested' },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AC#3a integrity reject: tampered leaf (transcriptHash mismatch) still rejects, regardless of ci-only anchor', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-isolated-tamper-'));
    try {
      const leaves = [makeIsolatedLeaf()];
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, ciOnlyKeys.privateKeyPem, {
        transcriptLeaves: leaves.map((l) => ({
          ...isolatedTranscriptLeafSummary(l),
          // Tamper: claim a different transcriptHash than the on-disk leaf's
          // Merkle-proved hash.
          transcriptHash: 'f'.repeat(64),
        })),
      });
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'invalid');
      assert.match(result.reason, /transcriptHash mismatch/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AC#3b integrity reject: root signature matching NO trusted key still rejects', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-isolated-untrusted-'));
    try {
      const leaves = [makeIsolatedLeaf()];
      const unknownKeys = genV6KeyPair();
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, unknownKeys.privateKeyPem, {
        transcriptLeaves: leaves.map(isolatedTranscriptLeafSummary),
      });
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(),
        repoRoot: tmp,
      });
      assert.equal(result.status, 'invalid');
      assert.match(result.reason, /rootSignature did not match any trusted reviewer pubkey/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AC#4: the offline verifier module imports no network client (fetch/http/https)', () => {
    const source = readFileSync(
      join(__dirname, '..', 'pipeline-cli', 'attestation-core', 'verify-core.mjs'),
      'utf-8',
    );
    assert.ok(!/from ['"]node:https?['"]/.test(source), 'must not import node:http(s)');
    assert.ok(!/\bfetch\(/.test(source), 'must not call fetch()');
  });
});

// ── AISDLC-421 — per-patch-id leaves + legacy shared-file fallback ──────────

describe('verifyV6Envelope (AISDLC-421 — per-patch-id leaves with shared fallback)', () => {
  let keys;
  const HEAD_SHA = 'a'.repeat(40);
  const PATCH_ID = 'b'.repeat(40);

  before(() => {
    keys = genV6KeyPair();
  });

  function makeTrustedReviewers(publicKeyPem) {
    return [
      {
        identity: 'test@example.com',
        machine: 'test',
        pubkey: publicKeyPem,
        addedAt: '2026-05-24',
        addedBy: 'test',
      },
    ];
  }

  /**
   * Write a per-patch-id leaves file (`.ai-sdlc/transcript-leaves/<patch-id>.jsonl`)
   * + a v6 envelope for those leaves at the patch-id-named filename.
   */
  function writeV6PerPatchIdFixture(root, headSha, patchId, leaves, privateKeyPem) {
    mkdirSync(join(root, '.ai-sdlc', 'attestations'), { recursive: true });
    mkdirSync(join(root, '.ai-sdlc', 'transcript-leaves'), { recursive: true });
    const leavesContent = leaves.map((l) => JSON.stringify(l)).join('\n') + '\n';
    writeFileSync(join(root, '.ai-sdlc', 'transcript-leaves', `${patchId}.jsonl`), leavesContent);
    const envelope = buildValidV6Envelope(headSha, leaves, privateKeyPem);
    const envPath = join(root, '.ai-sdlc', 'attestations', `${patchId}.v6.dsse.json`);
    writeFileSync(envPath, JSON.stringify(envelope, null, 2) + '\n');
    return { envelope, envPath };
  }

  it('AC#3 verifies an envelope whose leaves are in the per-patch-id file (post-AISDLC-421 canonical path)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aisdlc-421-v6-'));
    try {
      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];
      const { envelope } = writeV6PerPatchIdFixture(
        tmp,
        HEAD_SHA,
        PATCH_ID,
        leaves,
        keys.privateKeyPem,
      );
      // Sanity: NO shared file exists.
      assert.equal(existsSync(join(tmp, '.ai-sdlc', 'transcript-leaves.jsonl')), false);
      // Per-patch-id file exists.
      assert.equal(
        existsSync(join(tmp, '.ai-sdlc', 'transcript-leaves', `${PATCH_ID}.jsonl`)),
        true,
      );

      // Production wires patch-id-named envelopes by synthesizing
      // envelopeFileName from the subject SHA (so the binding check still
      // passes). Mirror that here.
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
        patchIdHint: PATCH_ID,
      });
      assert.equal(result.status, 'valid', `expected valid, got: ${result.reason}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AC#7 legacy envelope (shared transcript-leaves.jsonl only) still verifies via shared-file fallback', () => {
    // Pre-AISDLC-421 fixture: NO per-patch-id file. Leaves live in the shared file.
    const tmp = mkdtempSync(join(tmpdir(), 'aisdlc-421-legacy-'));
    try {
      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];
      const { envelope } = writeV6Fixture(tmp, HEAD_SHA, leaves, keys.privateKeyPem);
      // Sanity: shared file present, NO per-patch-id directory.
      assert.equal(existsSync(join(tmp, '.ai-sdlc', 'transcript-leaves.jsonl')), true);
      assert.equal(existsSync(join(tmp, '.ai-sdlc', 'transcript-leaves')), false);

      // Verifier resolves leaves via the SHARED-file fallback (no patchIdHint).
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
        // patchIdHint omitted — this is a legacy SHA-named envelope.
      });
      assert.equal(
        result.status,
        'valid',
        `expected legacy envelope to verify, got: ${result.reason}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('shared-fallback MUST filter by taskId when other PRs leaves are present (AISDLC-421 hotfix regression)', () => {
    // This test pins down the bug that ALL post-AISDLC-421 envelopes
    // shipped on the shared-fallback path were failing verification.
    //
    // Setup: shared file has leaves from THIS task AND another task. The
    // signer (sign-v6.ts) filters shared-file leaves to THIS task's only
    // via `filteredByTask`. Before the hotfix, the verifier returned ALL
    // shared-file leaves unfiltered → recomputed root differed → signature
    // verification failed even though the envelope was correctly signed.
    //
    // The fix makes the verifier symmetric: derive taskId from leaves
    // matching the envelope's transcriptHashes, then filter to that taskId.
    const tmp = mkdtempSync(join(tmpdir(), 'aisdlc-421-hotfix-'));
    try {
      const thisTaskLeaves = [
        { ...makeLeaf(10, 'code-reviewer', 'aaaa'.repeat(16)), taskId: 'AISDLC-THIS' },
        { ...makeLeaf(11, 'test-reviewer', 'bbbb'.repeat(16)), taskId: 'AISDLC-THIS' },
        { ...makeLeaf(12, 'security-reviewer', 'cccc'.repeat(16)), taskId: 'AISDLC-THIS' },
      ];
      const otherTaskNoiseLeaves = [
        { ...makeLeaf(0, 'code-reviewer', 'dead'.repeat(16)), taskId: 'AISDLC-OTHER' },
        { ...makeLeaf(1, 'test-reviewer', 'beef'.repeat(16)), taskId: 'AISDLC-OTHER' },
        { ...makeLeaf(2, 'security-reviewer', 'cafe'.repeat(16)), taskId: 'AISDLC-OTHER' },
      ];

      // Envelope signs ONLY this task's leaves (mirrors `filteredByTask` in signer).
      mkdirSync(join(tmp, '.ai-sdlc', 'attestations'), { recursive: true });
      const envelope = buildValidV6Envelope(HEAD_SHA, thisTaskLeaves, keys.privateKeyPem);
      writeFileSync(
        join(tmp, '.ai-sdlc', 'attestations', `${HEAD_SHA}.v6.dsse.json`),
        JSON.stringify(envelope, null, 2) + '\n',
      );

      // Shared file contains BOTH tasks' leaves interleaved.
      const allLeaves = [...otherTaskNoiseLeaves, ...thisTaskLeaves];
      const sharedContent = allLeaves.map((l) => JSON.stringify(l)).join('\n') + '\n';
      writeFileSync(join(tmp, '.ai-sdlc', 'transcript-leaves.jsonl'), sharedContent);

      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(
        result.status,
        'valid',
        `shared-fallback must filter by taskId — bug fix regression. reason: ${result.reason}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('per-patch-id-first: when BOTH files exist, the per-patch-id file wins', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aisdlc-421-prefer-'));
    try {
      const realLeaves = [
        makeLeaf(0, 'code-reviewer', 'aaaa'.repeat(16)),
        makeLeaf(1, 'test-reviewer', 'bbbb'.repeat(16)),
        makeLeaf(2, 'security-reviewer', 'cccc'.repeat(16)),
      ];
      // Different (stale) leaves in the shared file with the SAME taskId.
      // The envelope is signed against the per-patch-id file; if the verifier
      // mistakenly read the shared file, the rootHash wouldn't match the
      // recomputed root → verification would fail.
      const staleLeaves = [
        makeLeaf(0, 'code-reviewer', 'dead'.repeat(16)),
        makeLeaf(1, 'test-reviewer', 'beef'.repeat(16)),
        makeLeaf(2, 'security-reviewer', 'cafe'.repeat(16)),
      ];

      const { envelope } = writeV6PerPatchIdFixture(
        tmp,
        HEAD_SHA,
        PATCH_ID,
        realLeaves,
        keys.privateKeyPem,
      );
      // Inject the stale shared file alongside.
      const staleContent = staleLeaves.map((l) => JSON.stringify(l)).join('\n') + '\n';
      writeFileSync(join(tmp, '.ai-sdlc', 'transcript-leaves.jsonl'), staleContent);

      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
        patchIdHint: PATCH_ID,
      });
      assert.equal(
        result.status,
        'valid',
        `expected per-patch-id file to win over shared file, got: ${result.reason}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('SHA-named envelope whose leaves are in a per-patch-id file → scan-match path resolves it', () => {
    // Edge case: envelope was written with a legacy SHA-name (pre-AISDLC-398)
    // but the writer moved to per-patch-id leaves post-AISDLC-421. The
    // verifier scans `.ai-sdlc/transcript-leaves/*.jsonl` and matches by
    // leaf-hash superset.
    const tmp = mkdtempSync(join(tmpdir(), 'aisdlc-421-scan-'));
    try {
      const leaves = [
        makeLeaf(0, 'code-reviewer', 'aaaa'.repeat(16)),
        makeLeaf(1, 'test-reviewer', 'bbbb'.repeat(16)),
        makeLeaf(2, 'security-reviewer', 'cccc'.repeat(16)),
      ];
      mkdirSync(join(tmp, '.ai-sdlc', 'transcript-leaves'), { recursive: true });
      const leavesContent = leaves.map((l) => JSON.stringify(l)).join('\n') + '\n';
      // Per-patch-id file present (some patch-id).
      writeFileSync(join(tmp, '.ai-sdlc', 'transcript-leaves', `${PATCH_ID}.jsonl`), leavesContent);

      // Envelope signed for those leaves but NAMED by HEAD_SHA (legacy filename).
      const envelope = buildValidV6Envelope(HEAD_SHA, leaves, keys.privateKeyPem);
      mkdirSync(join(tmp, '.ai-sdlc', 'attestations'), { recursive: true });
      writeFileSync(
        join(tmp, '.ai-sdlc', 'attestations', `${HEAD_SHA}.v6.dsse.json`),
        JSON.stringify(envelope, null, 2) + '\n',
      );

      // Verifier called WITHOUT patchIdHint (because the envelope is SHA-named).
      // The scan-by-hash-superset path should find the leaves in the per-patch-id file.
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${HEAD_SHA}.v6.dsse.json`,
        headSha: HEAD_SHA,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
        // patchIdHint omitted — verifier must find via the directory scan.
      });
      assert.equal(
        result.status,
        'valid',
        `expected scan-match to resolve per-patch-id file, got: ${result.reason}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('isAttestationOnlyDescendant (AISDLC-419)', () => {
  // Create a tiny git repo, then assert the helper accepts attestation-only
  // descendant chains and rejects everything else.
  function initRepo() {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-desc-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmp });
    return tmp;
  }
  function commit(repo, files, msg) {
    for (const [path, content] of Object.entries(files)) {
      const full = join(repo, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: repo });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
  }

  it('returns true when subject === head', () => {
    const tmp = initRepo();
    try {
      const sha = commit(tmp, { 'a.txt': 'x' }, 'initial');
      assert.equal(isAttestationOnlyDescendant(sha, sha, tmp), true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns true when descendant adds ONLY attestation envelope files', () => {
    const tmp = initRepo();
    try {
      const subject = commit(tmp, { 'src/a.ts': 'export const A = 1;' }, 'feat: code');
      const head = commit(
        tmp,
        { '.ai-sdlc/attestations/deadbeef.v6.dsse.json': '{"x":1}' },
        'chore: sign attestation',
      );
      assert.equal(isAttestationOnlyDescendant(subject, head, tmp), true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns true through TWO stacked attestation-only chore commits', () => {
    const tmp = initRepo();
    try {
      const subject = commit(tmp, { 'src/a.ts': 'export const A = 1;' }, 'feat: code');
      commit(
        tmp,
        { '.ai-sdlc/attestations/aaaaaaaa.v6.dsse.json': '{"a":1}' },
        'chore: sign attestation (1)',
      );
      const head = commit(
        tmp,
        {
          '.ai-sdlc/attestations/bbbbbbbb.v6.dsse.json': '{"b":1}',
          '.ai-sdlc/transcript-leaves.jsonl': '{"l":1}\n',
        },
        'chore: sign attestation (2)',
      );
      assert.equal(isAttestationOnlyDescendant(subject, head, tmp), true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns FALSE when descendant changes a source file', () => {
    const tmp = initRepo();
    try {
      const subject = commit(tmp, { 'src/a.ts': 'export const A = 1;' }, 'feat: code');
      const head = commit(
        tmp,
        {
          '.ai-sdlc/attestations/cafe.v6.dsse.json': '{"c":1}',
          'src/a.ts': 'export const A = 2;', // ← source change — must reject
        },
        'fix: also change code',
      );
      assert.equal(isAttestationOnlyDescendant(subject, head, tmp), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns FALSE when subject is not an ancestor of head (different branch)', () => {
    const tmp = initRepo();
    try {
      const base = commit(tmp, { 'a.txt': 'x' }, 'initial');
      const head = commit(tmp, { 'b.txt': 'y' }, 'feat: head');
      // Create a divergent branch with a different commit
      execFileSync('git', ['checkout', '-q', '-b', 'side', base], { cwd: tmp });
      const sideSha = commit(tmp, { 'c.txt': 'z' }, 'feat: side');
      assert.equal(isAttestationOnlyDescendant(sideSha, head, tmp), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns FALSE for invalid SHAs', () => {
    const tmp = initRepo();
    try {
      const sha = commit(tmp, { 'a.txt': 'x' }, 'initial');
      assert.equal(isAttestationOnlyDescendant('not-a-sha', sha, tmp), false);
      assert.equal(isAttestationOnlyDescendant(sha, 'also-not', tmp), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('verifyV6Envelope (AISDLC-419 — attestation-only descendant relaxation)', () => {
  // These tests run inside a real git repo because the relaxation uses
  // `git merge-base --is-ancestor` + `git diff-tree`. Synthetic tmp-only
  // tests (above) still cover the strict failure modes.
  let keys;
  before(() => {
    keys = genV6KeyPair();
  });
  function makeTrustedReviewers(publicKeyPem) {
    return [
      { agentId: 'code-reviewer', pubkey: publicKeyPem, addedAt: '2026-01-01T00:00:00Z' },
      { agentId: 'test-reviewer', pubkey: publicKeyPem, addedAt: '2026-01-01T00:00:00Z' },
      { agentId: 'security-reviewer', pubkey: publicKeyPem, addedAt: '2026-01-01T00:00:00Z' },
    ];
  }
  function initRepo() {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-relax-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmp });
    return tmp;
  }
  function commit(repo, files, msg) {
    for (const [path, content] of Object.entries(files)) {
      const full = join(repo, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: repo });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
  }

  it('accepts envelope when subject.sha1 is ancestor of HEAD via attestation-only chore commit', () => {
    const tmp = initRepo();
    try {
      // C1 = signed commit; C2 = chore-attestation commit on top.
      const subjectSha = commit(tmp, { 'src/a.ts': 'export const A = 1;' }, 'feat: code');
      // Build a v6 envelope whose subject.sha1 = subjectSha
      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];
      const { envelope } = writeV6Fixture(tmp, subjectSha, leaves, keys.privateKeyPem);
      // Now create C2: an attestation-only commit on top.
      const headSha = commit(
        tmp,
        { '.ai-sdlc/attestations/ignored.v6.dsse.json': '{"placeholder":1}' },
        'chore: sign attestation (top-up)',
      );
      const result = verifyV6Envelope({
        envelope,
        // Caller (line 1709) synthesizes filename from subject.sha1 when patch-id-named.
        envelopeFileName: `${subjectSha}.v6.dsse.json`,
        headSha,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(
        result.status,
        'valid',
        `expected valid (attestation-only descendant), got: ${result.reason}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('REJECTS envelope when descendant chore commit ALSO changes source files', () => {
    const tmp = initRepo();
    try {
      const subjectSha = commit(tmp, { 'src/a.ts': 'export const A = 1;' }, 'feat: code');
      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];
      const { envelope } = writeV6Fixture(tmp, subjectSha, leaves, keys.privateKeyPem);
      // Sneak a source-file change into the descendant commit.
      const headSha = commit(
        tmp,
        {
          '.ai-sdlc/attestations/placeholder.v6.dsse.json': '{"x":1}',
          'src/a.ts': 'export const A = 2;', // ← tamper
        },
        'chore: sign + sneak code change',
      );
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${subjectSha}.v6.dsse.json`,
        headSha,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(
        result.status,
        'invalid',
        `expected invalid (source code changed), got: ${result.reason}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('REJECTS envelope when subject.sha1 is not an ancestor of HEAD', () => {
    const tmp = initRepo();
    try {
      const baseSha = commit(tmp, { 'a.txt': 'x' }, 'base');
      const headSha = commit(tmp, { 'b.txt': 'y' }, 'feat: head');
      // Create a divergent branch and sign for that commit instead.
      execFileSync('git', ['checkout', '-q', '-b', 'side', baseSha], { cwd: tmp });
      const sideSha = commit(tmp, { 'src/side.ts': 'export const S = 1;' }, 'feat: side');
      // Build envelope binding to sideSha (a non-ancestor of headSha on main).
      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];
      const { envelope } = writeV6Fixture(tmp, sideSha, leaves, keys.privateKeyPem);
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${sideSha}.v6.dsse.json`,
        headSha,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(
        result.status,
        'invalid',
        `expected invalid (not an ancestor), got: ${result.reason}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('runVerifier — v6 integration', () => {
  let fixture;
  let v6Keys;

  beforeEach(() => {
    fixture = setupFixture();
    v6Keys = genV6KeyPair();
    writeTrustedReviewersYaml(fixture.root, v6Keys.publicKeyPem);
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('AC#1: runVerifier returns valid for a correct v6 envelope', () => {
    const leaves = [
      makeLeaf(0, 'code-reviewer'),
      makeLeaf(1, 'test-reviewer'),
      makeLeaf(2, 'security-reviewer'),
    ];
    writeV6Fixture(fixture.root, fixture.headSha, leaves, v6Keys.privateKeyPem);
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'valid', `expected valid, got: ${out.reason}`);
    assert.equal(out.reason, 'ok');
  });

  it('AC#2: runVerifier returns invalid with v6-specific reason on bad signature', () => {
    const leaves = [
      makeLeaf(0, 'code-reviewer'),
      makeLeaf(1, 'test-reviewer'),
      makeLeaf(2, 'security-reviewer'),
    ];
    // Write envelope signed with a different (untrusted) key.
    // v6Keys is registered as trusted, but untrustedKeys is used to sign.
    const untrustedKeys = genV6KeyPair();
    writeV6Fixture(fixture.root, fixture.headSha, leaves, untrustedKeys.privateKeyPem);
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'invalid');
    assert.match(out.reason, /rootSignature did not match any trusted reviewer pubkey/);
  });

  it('AISDLC-492: SHA-named-only envelope (subject.sha1 === headSha) still verifies via isAttestationOnlyDescendant', () => {
    // After removing the per-SHA fallback, an envelope whose filename is
    // `${headSha}.v6.dsse.json` with subject.sha1 === headSha must STILL be
    // accepted. isAttestationOnlyDescendant(headSha, headSha, ...) short-circuits
    // to true (equal-SHA early return), surfacing the envelope to the candidate
    // set even without the per-SHA filename check. This confirms the removal
    // does not break the current-era signing shape where the chore commit
    // makes HEAD === the signed subject.
    const leaves = [
      makeLeaf(0, 'code-reviewer'),
      makeLeaf(1, 'test-reviewer'),
      makeLeaf(2, 'security-reviewer'),
    ];
    // Envelope is SHA-named (headSha = subjectSha) — exactly the bridge shape
    // that existed before AISDLC-475 wrote the patch-id-named primary.
    writeV6Fixture(fixture.root, fixture.headSha, leaves, v6Keys.privateKeyPem);
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(
      out.status,
      'valid',
      `expected valid (SHA-named envelope surfaced via isAttestationOnlyDescendant equal-SHA path), got: ${out.reason}`,
    );
    assert.equal(out.reason, 'ok');
  });

  it('AISDLC-723: rejects a correctness-only attestation on a source diff', () => {
    writeV6Fixture(
      fixture.root,
      fixture.headSha,
      [makeLeaf(0, 'correctness-reviewer')],
      v6Keys.privateKeyPem,
    );
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'invalid');
    assert.match(out.reason, /reviewer set incomplete for a 'full' diff.*security-reviewer/);
  });

  it('AISDLC-723: accepts correctness + security on a source diff and reports the re-derived scope', () => {
    writeV6Fixture(
      fixture.root,
      fixture.headSha,
      [makeLeaf(0, 'correctness-reviewer'), makeLeaf(1, 'security-reviewer')],
      v6Keys.privateKeyPem,
    );
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'valid', `got: ${out.reason}`);
    assert.equal(out.reviewScope.classification, 'full');
  });

  it('AISDLC-723: a renamed envelope leaf (not matching the on-disk leaf) is rejected', () => {
    const { envelope, envPath } = writeV6Fixture(
      fixture.root,
      fixture.headSha,
      [makeLeaf(0, 'correctness-reviewer')],
      v6Keys.privateKeyPem,
    );
    // The envelope JSON is editable after signing without the key.
    envelope.transcriptLeaves[0].reviewerName = 'security-reviewer';
    writeFileSync(envPath, JSON.stringify(envelope, null, 2) + '\n');
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'invalid');
    assert.match(out.reason, /reviewerName mismatch/);
  });

  it('AISDLC-723: a duplicated leafIndex entry appended to the envelope is rejected', () => {
    const { envelope, envPath } = writeV6Fixture(
      fixture.root,
      fixture.headSha,
      [makeLeaf(0, 'correctness-reviewer')],
      v6Keys.privateKeyPem,
    );
    envelope.transcriptLeaves.push({
      ...envelope.transcriptLeaves[0],
      reviewerName: 'security-reviewer',
    });
    envelope.merkleProofs.push({ ...envelope.merkleProofs[0] });
    writeFileSync(envPath, JSON.stringify(envelope, null, 2) + '\n');
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'invalid');
  });

  it('AISDLC-492: envelope named for a non-ancestor SHA is not surfaced (per-SHA fallback removed)', () => {
    // Confirms the per-SHA fallback is gone: an envelope whose filename is a
    // random 40-hex string that is NOT the current HEAD and whose subject.sha1
    // is also NOT an ancestor of HEAD must NOT be accepted. Without the fallback,
    // the broadened filter can only surface this envelope if its subject.sha1 is
    // an attestation-only ancestor or a tree-equivalent orphan — neither holds here.
    // Result: no v6 envelope is surfaced, verifier falls through to legacy (none
    // present), returns invalid.
    const leaves = [
      makeLeaf(0, 'code-reviewer'),
      makeLeaf(1, 'test-reviewer'),
      makeLeaf(2, 'security-reviewer'),
    ];
    // Write an envelope that binds to fixture.baseSha (an ancestor, but
    // NOT an attestation-only ancestor — the diff includes source files).
    // Name it with a random hex to simulate a stale per-SHA bridge file.
    const staleHex = '0'.repeat(40);
    const envBytes = JSON.stringify(
      buildValidV6Envelope(fixture.baseSha, leaves, v6Keys.privateKeyPem),
      null,
      2,
    );
    writeFileSync(
      join(fixture.root, '.ai-sdlc', 'attestations', `${staleHex}.v6.dsse.json`),
      envBytes + '\n',
    );
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    // The stale envelope must not be accepted: it binds to baseSha, which IS an
    // ancestor of headSha but the diff from baseSha→headSha includes feature.txt
    // (a non-attestation file), so isAttestationOnlyDescendant returns false.
    // isTreeEquivalentModuloAttestation also returns false (different trees).
    // No v6 envelope is surfaced → falls to legacy → no legacy envelope → invalid.
    assert.equal(
      out.status,
      'invalid',
      `expected invalid (stale non-ancestor envelope must not surface without per-SHA fallback), got: ${out.reason}`,
    );
  });
});

// ── AISDLC-398 fix #3: v5 fast-path content-hash recompute ───────────────────
//
// Verifies that the v5 patch-id fast-path correctly recomputes contentHashV5
// from the CURRENT HEAD's files rather than comparing the stored hash against
// itself. A force-push that changes blob SHAs (but preserves the unified diff
// structure) MUST be rejected.
describe('runVerifier (AISDLC-419 follow-up — broaden v6 envelope filter)', () => {
  // Reproduces the production failure mode: a v6 envelope sits on disk
  // named for the parent-of-HEAD (the "signed commit"). The chore commit
  // on top only adds attestation files. The verifier's strict
  // patch-id-or-HEAD-sha filter would skip the envelope entirely; with
  // the broadened filter (AISDLC-419 follow-up) the envelope surfaces
  // and the inner descendant-relaxation accepts it.
  let fixture;
  let v6Keys;

  beforeEach(() => {
    fixture = setupFixture();
    v6Keys = genV6KeyPair();
    writeTrustedReviewersYaml(fixture.root, v6Keys.publicKeyPem);
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('accepts a v6 envelope whose subject.sha1 is an attestation-only ancestor of HEAD (post-rebase shape)', () => {
    // Write a v6 envelope binding to fixture.headSha (the work commit).
    const leaves = [
      makeLeaf(0, 'code-reviewer'),
      makeLeaf(1, 'test-reviewer'),
      makeLeaf(2, 'security-reviewer'),
    ];
    writeV6Fixture(fixture.root, fixture.headSha, leaves, v6Keys.privateKeyPem);

    // Now add an attestation-only chore commit on top. Use a fake patch-id
    // filename to mirror the production shape (the file is named for an
    // arbitrary 40-hex that is NEITHER the chore HEAD nor the verifier's
    // computed patch-id). This is the case the original AISDLC-419 fix
    // failed to surface because the filter ignored the envelope.
    const FAKE_PATCH_ID = 'a'.repeat(40);
    writeFileSync(
      join(fixture.root, '.ai-sdlc', 'attestations', `${FAKE_PATCH_ID}.v6.dsse.json`),
      readFileSync(
        join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.v6.dsse.json`),
        'utf-8',
      ),
    );
    // Remove the per-HEAD bridge so the only matchable envelope is the
    // fake-patch-id one (forces the broadened filter to be exercised).
    rmSync(join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.v6.dsse.json`));

    // Create the chore commit. Re-stash transcript-leaves first because
    // the chore commit only adds attestation files.
    execFileSync('git', ['add', '.ai-sdlc/attestations/', '.ai-sdlc/transcript-leaves.jsonl'], {
      cwd: fixture.root,
    });
    execFileSync('git', ['commit', '-q', '-m', 'chore: sign v6 attestation'], {
      cwd: fixture.root,
    });
    const choreHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.root,
      encoding: 'utf-8',
    }).trim();

    // Run verifier with the chore commit as HEAD — this is what CI sees
    // after the pre-push attestation-sign hook adds the chore commit.
    const out = runVerifier({
      headSha: choreHead,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(
      out.status,
      'valid',
      `expected valid (envelope surfaced via broadened filter), got: ${out.reason}`,
    );
  });

  it('STILL rejects when the descendant chore commit ALSO changes source files', () => {
    // Same setup as above but smuggle a source-file change into the
    // descendant chore commit. The broadened filter still surfaces the
    // envelope (subject.sha1 is an ancestor), but the inner
    // isAttestationOnlyDescendant check rejects because the diff isn't
    // attestation-only.
    const leaves = [
      makeLeaf(0, 'code-reviewer'),
      makeLeaf(1, 'test-reviewer'),
      makeLeaf(2, 'security-reviewer'),
    ];
    writeV6Fixture(fixture.root, fixture.headSha, leaves, v6Keys.privateKeyPem);
    const FAKE_PATCH_ID = 'b'.repeat(40);
    writeFileSync(
      join(fixture.root, '.ai-sdlc', 'attestations', `${FAKE_PATCH_ID}.v6.dsse.json`),
      readFileSync(
        join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.v6.dsse.json`),
        'utf-8',
      ),
    );
    rmSync(join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.v6.dsse.json`));
    // Tamper a source file in the chore commit.
    writeFileSync(join(fixture.root, 'feature.txt'), 'feature\nTAMPERED\n');
    execFileSync(
      'git',
      ['add', '.ai-sdlc/attestations/', '.ai-sdlc/transcript-leaves.jsonl', 'feature.txt'],
      { cwd: fixture.root },
    );
    execFileSync('git', ['commit', '-q', '-m', 'chore: sign + tamper'], { cwd: fixture.root });
    const tamperedHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.root,
      encoding: 'utf-8',
    }).trim();
    const out = runVerifier({
      headSha: tamperedHead,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(
      out.status,
      'invalid',
      `expected invalid (source code tampered between sign and push), got: ${out.reason}`,
    );
  });
});

// AISDLC-810: the AISDLC-448 tree-equivalence relaxation was deleted. An
// envelope whose subject was orphaned by a rebase is rejected even when the
// orphaned commit still exists locally (CI never has it); the pre-push hook
// re-signs instead.
describe('verifyV6Envelope (AISDLC-810 — orphaned subject is rejected)', () => {
  // Build a real v6 envelope bound to a soon-to-be-orphaned dev commit,
  // orphan it via rebase, add a chore-attestation commit on top, and assert
  // verifyV6Envelope rejects it.
  let keys;
  before(() => {
    keys = genV6KeyPair();
  });
  function makeTrustedReviewers(publicKeyPem) {
    return [
      { agentId: 'code-reviewer', pubkey: publicKeyPem, addedAt: '2026-01-01T00:00:00Z' },
      { agentId: 'test-reviewer', pubkey: publicKeyPem, addedAt: '2026-01-01T00:00:00Z' },
      { agentId: 'security-reviewer', pubkey: publicKeyPem, addedAt: '2026-01-01T00:00:00Z' },
    ];
  }
  function initRepo() {
    const tmp = mkdtempSync(join(tmpdir(), 'v6-orphan-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmp });
    return tmp;
  }
  function commit(repo, files, msg) {
    for (const [path, content] of Object.entries(files)) {
      const full = join(repo, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: repo });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
  }

  it('REJECTS envelope when subject is orphaned by a rebase even though trees are identical and the orphan still exists locally', () => {
    const tmp = initRepo();
    try {
      // Phase 1: dev signs against original feature commit.
      const baseSha = commit(tmp, { 'baseline.txt': 'baseline\n' }, 'baseline');
      const signedSha = commit(
        tmp,
        { 'src/feature.ts': 'export const F = 1;\n' },
        'feat: original dev',
      );
      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];
      const { envelope } = writeV6Fixture(tmp, signedSha, leaves, keys.privateKeyPem);

      // Phase 2: rebase orphans signedSha. Stash + re-apply same source on a
      // new branch off baseSha. The new HEAD has the same source tree as
      // signedSha, but signedSha is no longer in HEAD's ancestor chain.
      execFileSync('git', ['checkout', '-q', '-b', 'rebased', baseSha], { cwd: tmp });
      mkdirSync(join(tmp, 'src'), { recursive: true });
      writeFileSync(join(tmp, 'src', 'feature.ts'), 'export const F = 1;\n');
      execFileSync('git', ['add', '-A'], { cwd: tmp });
      execFileSync('git', ['commit', '-q', '-m', 'feat: dev (rebased)'], { cwd: tmp });

      // Phase 3: chore commit lands on top, materialising the attestation
      // envelope under a fake patch-id filename (mirrors production where
      // signer + verifier compute different patch-ids).
      const FAKE_PATCH_ID = 'a'.repeat(40);
      mkdirSync(join(tmp, '.ai-sdlc', 'attestations'), { recursive: true });
      const envelopeJson = JSON.stringify(envelope, null, 2);
      writeFileSync(
        join(tmp, '.ai-sdlc', 'attestations', `${FAKE_PATCH_ID}.v6.dsse.json`),
        envelopeJson,
      );
      writeFileSync(
        join(tmp, '.ai-sdlc', 'transcript-leaves.jsonl'),
        leaves.map((l) => JSON.stringify(l)).join('\n') + '\n',
      );
      const choreHead = commit(tmp, {}, 'chore: sign attestation (post-rebase)');

      // Phase 4: verify. signedSha still exists in this clone (orphaned, not
      // gc'd) and the trees are identical, but it is not an ancestor of HEAD.
      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${FAKE_PATCH_ID}.v6.dsse.json`,
        headSha: choreHead,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(
        result.status,
        'invalid',
        `expected invalid (orphaned subject), got: ${result.reason}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('REJECTS envelope when rebase resolved a source-byte conflict (tampering between sign and rebased HEAD)', () => {
    // Same orphan shape, but the rebased branch's source content differs
    // from the originally-signed content. Still rejected.
    const tmp = initRepo();
    try {
      const baseSha = commit(tmp, { 'baseline.txt': 'baseline\n' }, 'baseline');
      const signedSha = commit(
        tmp,
        { 'src/feature.ts': 'export const F = 1;\n' },
        'feat: original dev',
      );
      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];
      const { envelope } = writeV6Fixture(tmp, signedSha, leaves, keys.privateKeyPem);

      execFileSync('git', ['checkout', '-q', '-b', 'rebased', baseSha], { cwd: tmp });
      mkdirSync(join(tmp, 'src'), { recursive: true });
      // ← different source content from signedSha's tree
      writeFileSync(join(tmp, 'src', 'feature.ts'), 'export const F = 999;\n');
      execFileSync('git', ['add', '-A'], { cwd: tmp });
      execFileSync('git', ['commit', '-q', '-m', 'feat: dev (rebased + altered)'], {
        cwd: tmp,
      });

      const FAKE_PATCH_ID = 'b'.repeat(40);
      mkdirSync(join(tmp, '.ai-sdlc', 'attestations'), { recursive: true });
      writeFileSync(
        join(tmp, '.ai-sdlc', 'attestations', `${FAKE_PATCH_ID}.v6.dsse.json`),
        JSON.stringify(envelope, null, 2),
      );
      writeFileSync(
        join(tmp, '.ai-sdlc', 'transcript-leaves.jsonl'),
        leaves.map((l) => JSON.stringify(l)).join('\n') + '\n',
      );
      const choreHead = commit(tmp, {}, 'chore: sign attestation (post-rebase, altered)');

      const result = verifyV6Envelope({
        envelope,
        envelopeFileName: `${FAKE_PATCH_ID}.v6.dsse.json`,
        headSha: choreHead,
        trustedReviewers: makeTrustedReviewers(keys.publicKeyPem),
        repoRoot: tmp,
      });
      assert.equal(
        result.status,
        'invalid',
        `expected invalid (orphan tree diverged from HEAD), got: ${result.reason}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runVerifier rejects an orphan-subject envelope (no candidate-filter relaxation)', () => {
    // End-to-end through runVerifier: an envelope whose subject was orphaned
    // by a rebase is not surfaced and the verifier does not return valid.
    const fixture = setupFixture();
    const v6Keys = genV6KeyPair();
    writeTrustedReviewersYaml(fixture.root, v6Keys.publicKeyPem);
    try {
      const leaves = [
        makeLeaf(0, 'code-reviewer'),
        makeLeaf(1, 'test-reviewer'),
        makeLeaf(2, 'security-reviewer'),
      ];
      // Sign against the fixture's headSha.
      writeV6Fixture(fixture.root, fixture.headSha, leaves, v6Keys.privateKeyPem);

      // Read the envelope bytes back, rename to a fake patch-id filename,
      // and orphan the original SHA via reset/recommit on a new branch.
      const envBytes = readFileSync(
        join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.v6.dsse.json`),
        'utf-8',
      );
      rmSync(join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.v6.dsse.json`));
      const FAKE_PATCH_ID = 'c'.repeat(40);

      // Reset to base, replay the same feature content under a new commit
      // (orphans fixture.headSha).
      execFileSync('git', ['checkout', '-q', '-b', 'rebased', fixture.baseSha], {
        cwd: fixture.root,
      });
      writeFileSync(join(fixture.root, 'feature.txt'), 'feature\n');
      execFileSync('git', ['add', 'feature.txt'], { cwd: fixture.root });
      execFileSync('git', ['commit', '-q', '-m', 'feat: re-applied'], { cwd: fixture.root });

      // Materialise the renamed envelope + leaves on the rebased branch.
      mkdirSync(join(fixture.root, '.ai-sdlc', 'attestations'), { recursive: true });
      writeFileSync(
        join(fixture.root, '.ai-sdlc', 'attestations', `${FAKE_PATCH_ID}.v6.dsse.json`),
        envBytes,
      );
      writeFileSync(
        join(fixture.root, '.ai-sdlc', 'transcript-leaves.jsonl'),
        leaves.map((l) => JSON.stringify(l)).join('\n') + '\n',
      );
      execFileSync('git', ['add', '.ai-sdlc/attestations/', '.ai-sdlc/transcript-leaves.jsonl'], {
        cwd: fixture.root,
      });
      execFileSync('git', ['commit', '-q', '-m', 'chore: sign v6 attestation'], {
        cwd: fixture.root,
      });
      const choreHead = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: fixture.root,
        encoding: 'utf-8',
      }).trim();

      const out = runVerifier({
        headSha: choreHead,
        baseSha: fixture.baseSha,
        repoRoot: fixture.root,
      });
      assert.notEqual(
        out.status,
        'valid',
        `expected non-valid (orphaned subject must be rejected), got: ${out.reason}`,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('AISDLC-734: bounded scan + required reviewer set', () => {
  it('resolveScanBudgetMs accepts a positive integer and defaults otherwise', () => {
    assert.equal(resolveScanBudgetMs('2500'), 2500);
    assert.equal(resolveScanBudgetMs(' 90 '), 90);
    for (const bad of [undefined, '', '0', '-5', '1.5', 'abc']) {
      assert.equal(resolveScanBudgetMs(bad), DEFAULT_VERIFIER_SCAN_BUDGET_MS, String(bad));
    }
  });

  it('describeRequiredReviewerSet names all three roles and their codex variants', () => {
    const line = describeRequiredReviewerSet();
    assert.match(line, /^required reviewers: /);
    assert.match(line, /code-reviewer \(or code-reviewer-codex\)/);
    assert.match(line, /test-reviewer \(or test-reviewer-codex\)/);
    assert.match(line, /security-reviewer/);
  });
});

describe('runVerifier (AISDLC-734 — bounded v6 candidate walk)', () => {
  let fixture;
  let keys;
  const ENV_KEYS = ['AI_SDLC_VERIFIER_SCAN_BUDGET_MS', 'AI_SDLC_VERIFIER_SCAN_MAX_CANDIDATES'];
  let savedEnv;
  const NAMED = `${'a'.repeat(40)}.v6.dsse.json`;

  const attPath = (name) => join(fixture.root, '.ai-sdlc', 'attestations', name);
  function attDirMove(from, to) {
    const body = readFileSync(attPath(from), 'utf-8');
    rmSync(attPath(from));
    writeFileSync(attPath(to), body);
  }
  /** Copy the valid envelope under `name`, overriding fields. */
  function plant(name, overrides) {
    const base = JSON.parse(readFileSync(attPath(NAMED), 'utf-8'));
    writeFileSync(attPath(name), JSON.stringify({ ...base, ...overrides }));
  }
  const run = (extra = {}) =>
    runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
      ...extra,
    });
  function captureStderr(fn) {
    const orig = process.stderr.write;
    let text = '';
    process.stderr.write = (chunk) => {
      text += String(chunk);
      return true;
    };
    try {
      return { out: fn(), text };
    } finally {
      process.stderr.write = orig;
    }
  }
  // First call = scan start; every later call is far past any budget.
  const exhaustedClock = () => {
    let calls = 0;
    return () => (calls++ === 0 ? 0 : 10_000_000);
  };

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    fixture = setupFixture();
    keys = genV6KeyPair();
    writeTrustedReviewersYaml(fixture.root, keys.publicKeyPem);
    const leaves = [
      makeLeaf(0, 'code-reviewer'),
      makeLeaf(1, 'test-reviewer'),
      makeLeaf(2, 'security-reviewer'),
    ];
    writeV6Fixture(fixture.root, fixture.headSha, leaves, keys.privateKeyPem);
    // Arbitrary 40-hex name: found only by the walk (subject.sha1 = head qualifies
    // via the ancestor relaxation).
    attDirMove(`${fixture.headSha}.v6.dsse.json`, NAMED);
    // Attestation-only chore commit on top: the envelope's subject is then an
    // attestation-only ancestor of HEAD (the production shape).
    execFileSync('git', ['add', '.ai-sdlc/attestations/', '.ai-sdlc/transcript-leaves.jsonl'], {
      cwd: fixture.root,
    });
    execFileSync('git', ['commit', '-q', '-m', 'chore: sign v6 attestation'], {
      cwd: fixture.root,
    });
    fixture.headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.root,
      encoding: 'utf-8',
    }).trim();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('(a) the newest-first walk picks the newest qualifying envelope, as the old filter-then-sort did', () => {
    assert.equal(run().status, 'valid');
    // A newer qualifying envelope with a broken signature wins over the older valid one.
    plant(`${'b'.repeat(40)}.v6.dsse.json`, {
      signedAt: '2026-06-01T00:00:00.000Z',
      rootSignature: Buffer.from('not a signature').toString('base64'),
    });
    assert.equal(run().status, 'invalid');
    // A newer NON-qualifying envelope (subject unreachable) is skipped; the walk
    // continues to the next qualifying one, which is the broken 'b' again.
    plant(`${'c'.repeat(40)}.v6.dsse.json`, {
      signedAt: '2026-07-01T00:00:00.000Z',
      subject: { digest: { sha1: '9'.repeat(40) } },
    });
    assert.equal(run().status, 'invalid');
    // Remove the broken one: the skipped non-qualifier does not hide the valid one.
    rmSync(attPath(`${'b'.repeat(40)}.v6.dsse.json`));
    assert.equal(run().status, 'valid');
  });

  it('(b) wall-clock budget exhaustion fails closed naming AI_SDLC_VERIFIER_SCAN_BUDGET_MS', () => {
    const out = run({ now: exhaustedClock() });
    assert.equal(out.status, 'invalid');
    assert.match(out.reason, /AI_SDLC_VERIFIER_SCAN_BUDGET_MS/);
    assert.match(out.reason, /scan budget/);
  });

  it('(b2) the candidate-count cap fails closed the same way, independent of the clock', () => {
    process.env.AI_SDLC_VERIFIER_SCAN_MAX_CANDIDATES = '1';
    // A newer non-qualifying envelope occupies the single allowed slot.
    plant(`${'c'.repeat(40)}.v6.dsse.json`, {
      signedAt: '2030-01-01T00:00:00.000Z',
      subject: { digest: { sha1: '9'.repeat(40) } },
    });
    const out = run();
    assert.equal(out.status, 'invalid');
    assert.match(out.reason, /AI_SDLC_VERIFIER_SCAN_BUDGET_MS/);
    process.env.AI_SDLC_VERIFIER_SCAN_MAX_CANDIDATES = '2';
    assert.equal(run().status, 'valid');
  });

  it('(d) prints the required reviewer set on stderr', () => {
    const { text } = captureStderr(() => run());
    assert.match(
      text,
      /\[verify-attestation\] required reviewers: code-reviewer \(or code-reviewer-codex\); test-reviewer \(or test-reviewer-codex\); security-reviewer/,
    );
  });

  it('fast path: the exact patch-id-named envelope is found before the timed walk', () => {
    const patchId = computePatchIdForVerifier(fixture.baseSha, fixture.headSha, fixture.root);
    assert.match(patchId ?? '', /^[0-9a-f]{40}$/);
    attDirMove(NAMED, `${patchId}.v6.dsse.json`);
    const base = JSON.parse(readFileSync(attPath(`${patchId}.v6.dsse.json`), 'utf-8'));
    // Decoys with far-future unsigned signedAt values that would fill any walk.
    for (const c of ['1', '2', '3']) {
      writeFileSync(
        attPath(`${c.repeat(40)}.v6.dsse.json`),
        JSON.stringify({
          ...base,
          signedAt: '2099-01-01T00:00:00.000Z',
          subject: { digest: { sha1: '9'.repeat(40) } },
        }),
      );
    }
    process.env.AI_SDLC_VERIFIER_SCAN_MAX_CANDIDATES = '1';
    const out = run({ now: exhaustedClock() });
    assert.equal(out.status, 'valid', `expected valid via fast path, got: ${out.reason}`);
  });

  it('resolveScanMaxCandidates accepts a positive integer and defaults otherwise', () => {
    assert.equal(resolveScanMaxCandidates('7'), 7);
    for (const bad of [undefined, '', '0', '-1', 'x']) {
      assert.equal(resolveScanMaxCandidates(bad), 300, String(bad));
    }
  });
});

describe('runVerifier (AISDLC-722 — two-leaf envelope on a trust-chain diff)', () => {
  let fixture;
  let keys;

  /** Commit `relPath` on top of the fixture head and return the new head SHA. */
  function commitFile(relPath) {
    mkdirSync(join(fixture.root, relPath, '..'), { recursive: true });
    writeFileSync(join(fixture.root, relPath), '// x\n');
    git(['add', '--', relPath], fixture.root);
    git(['commit', '-q', '-m', 'touch trust-chain path'], fixture.root);
    return git(['rev-parse', 'HEAD'], fixture.root).trim();
  }

  const twoLeaves = () => [makeLeaf(0, 'correctness-reviewer'), makeLeaf(1, 'security-reviewer')];

  beforeEach(() => {
    fixture = setupFixture();
    keys = genV6KeyPair();
    writeTrustedReviewersYaml(fixture.root, keys.publicKeyPem);
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('accepts a two-leaf envelope when the diff touches no trust-chain path', () => {
    writeV6Fixture(fixture.root, fixture.headSha, twoLeaves(), keys.privateKeyPem);
    const out = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(out.status, 'valid', `expected valid, got: ${out.reason}`);
  });

  it('rejects a two-leaf envelope when the diff touches a plugin hook', () => {
    const head = commitFile('ai-sdlc-plugin/hooks/x.js');
    writeV6Fixture(fixture.root, head, twoLeaves(), keys.privateKeyPem);
    const out = runVerifier({ headSha: head, baseSha: fixture.baseSha, repoRoot: fixture.root });
    assert.equal(out.status, 'invalid');
    assert.match(out.reason, /reviewer set incomplete/);
    assert.match(out.reason, /ai-sdlc-plugin\/hooks\/x\.js/);
  });

  it('rejects a two-leaf envelope when the trust-chain filename is non-ASCII (git would C-quote it)', () => {
    const head = commitFile('ai-sdlc-plugin/hooks/héllo.js');
    writeV6Fixture(fixture.root, head, twoLeaves(), keys.privateKeyPem);
    const out = runVerifier({ headSha: head, baseSha: fixture.baseSha, repoRoot: fixture.root });
    assert.equal(out.status, 'invalid');
    assert.match(out.reason, /reviewer set incomplete/);
  });
});
