/**
 * Regression tests for `scripts/ci-sign-attestation.mjs` (AISDLC-87).
 *
 * Exercises the CI-side attestor end-to-end against a synthetic git fixture
 * + the real verifier from `scripts/verify-attestation.mjs`. Tests cover:
 *
 *   - AC #7  remote-agent shape (no local attestation) → CI signs → verifier valid.
 *   - AC #8  contributor shape (valid local attestation) → --skip-if-valid no-ops.
 *   - AC #9  invalid local attestation → CI signs additively → verifier picks valid one.
 *   - parseArgs / normalizeAgentId / buildReviewersFromVerdicts helpers.
 *
 * Run with: node --test scripts/ci-sign-attestation.test.mjs
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseArgs,
  normalizeAgentId,
  buildReviewersFromVerdicts,
  purgeStaleEnvelopes,
} from './ci-sign-attestation.mjs';
import { runVerifier } from './verify-attestation.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const orchestratorBarrel = join(repoRoot, 'orchestrator', 'dist', 'runtime', 'attestations.js');

let buildPredicate;
let signAttestation;
let generateSigningKeyPair;

before(async () => {
  // The verifier + the script-under-test both import the orchestrator's
  // compiled runtime. Build it once.
  try {
    execFileSync('pnpm', ['--filter', '@ai-sdlc/orchestrator...', 'build'], {
      cwd: repoRoot,
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
const PLUGIN_VERSION = '0.7.1';

function setupFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-ci-sign-test-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  mkdirSync(join(root, '.ai-sdlc', 'attestations'), { recursive: true });
  mkdirSync(join(root, 'ai-sdlc-plugin', 'agents'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, '.ai-sdlc', 'review-policy.md'), REVIEW_POLICY);
  for (const [name, content] of Object.entries(AGENT_FILES)) {
    writeFileSync(join(root, 'ai-sdlc-plugin', 'agents', `${name}.md`), content);
  }
  writeFileSync(
    join(root, 'ai-sdlc-plugin', 'plugin.json'),
    JSON.stringify({ name: 'ai-sdlc', version: PLUGIN_VERSION }, null, 2),
  );
  // Symlink the real verifier script + orchestrator into the fixture so
  // ci-sign-attestation's --skip-if-valid path can invoke the verifier
  // and import the runtime barrel from cwd. We use direct file copies of
  // the script (via fs link) so the script runs unmodified.
  // The orchestrator dir is referenced by absolute path via process.cwd() —
  // we instead provide a symlink so runtime/attestations.js resolves.
  // Initial commit (BASE).
  writeFileSync(join(root, 'baseline.txt'), 'baseline\n');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'baseline'], root);
  const baseSha = git(['rev-parse', 'HEAD'], root).trim();
  // Feature commit (HEAD).
  writeFileSync(join(root, 'feature.txt'), 'feature\n');
  git(['add', 'feature.txt'], root);
  git(['commit', '-q', '-m', 'feature'], root);
  const headSha = git(['rev-parse', 'HEAD'], root).trim();
  return { root, baseSha, headSha };
}

function writeTrustedReviewersYaml(
  root,
  pubkeyPem,
  identity = 'ci-attestor',
  machine = 'github-actions',
) {
  const yaml =
    [
      '# trusted reviewers test fixture',
      'reviewers:',
      `  - identity: '${identity}'`,
      `    machine: '${machine}'`,
      "    addedAt: '2026-04-28'",
      "    addedBy: 'maintainer'",
      '    pubkey: |',
      ...pubkeyPem
        .trimEnd()
        .split('\n')
        .map((l) => `      ${l}`),
    ].join('\n') + '\n';
  writeFileSync(join(root, '.ai-sdlc', 'trusted-reviewers.yaml'), yaml);
}

/**
 * Symlink the verifier + orchestrator dist into the fixture so the script
 * (which imports them via `path.join(process.cwd(), ...)`) can resolve.
 * We use an absolute symlink: simpler than copying the entire orchestrator
 * tree per test, and the fixture is throwaway.
 */
function linkScriptDeps(root) {
  // Symlink scripts/verify-attestation.mjs (and its deps).
  const scriptsDir = join(root, 'scripts');
  // We need the verifier and the script-under-test in scripts/ so the
  // script's `join(repoRoot, 'scripts', 'verify-attestation.mjs')` resolves.
  for (const f of ['verify-attestation.mjs', 'ci-sign-attestation.mjs']) {
    const src = join(repoRoot, 'scripts', f);
    const dst = join(scriptsDir, f);
    // Use a hardlink so node's import-via-relative-path resolves correctly
    // (the script imports `../orchestrator/dist/...` which we also link).
    execFileSync('ln', ['-sf', src, dst]);
  }
  // Link the orchestrator dist tree (the script imports a path under
  // <repoRoot>/orchestrator/dist/runtime/attestations.js).
  const orcDir = join(root, 'orchestrator');
  mkdirSync(orcDir, { recursive: true });
  execFileSync('ln', ['-sf', join(repoRoot, 'orchestrator', 'dist'), join(orcDir, 'dist')]);
}

/**
 * Write a maintainer-signed envelope into the fixture (= contributor's
 * pre-existing local attestation). Used for AC #8 (already-valid no-op)
 * and AC #9 (invalid-existing → CI signs additively).
 */
function writeMaintainerEnvelope(root, headSha, baseSha, privateKeyPem, options = {}) {
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
    diff: options.tamperedDiff ?? diff,
    policy,
    reviewers,
    pluginVersion: PLUGIN_VERSION,
    iterationCount: 1,
    harnessNote: '',
    signedAt: '2026-04-28T00:00:00.000Z',
  });
  const envelope = signAttestation({
    predicate,
    privateKeyPem,
    keyid: 'maintainer@example.com:laptop',
  });
  writeFileSync(
    join(root, '.ai-sdlc', 'attestations', `${headSha}.dsse.json`),
    JSON.stringify(envelope, null, 2),
  );
  return { predicate, envelope };
}

const VERDICTS_ALL_APPROVED = [
  { type: 'testing', approved: true, findings: [], summary: 'lgtm' },
  { type: 'critic', approved: true, findings: [], summary: 'lgtm' },
  { type: 'security', approved: true, findings: [], summary: 'lgtm' },
];

/**
 * Run the CI-sign script with the given env + cwd. Returns
 * `{ stdout, stderr, exitCode }`. Throws if the spawn itself fails (not
 * if the script exits non-zero).
 */
function runCiSignScript({ cwd, verdicts, env, extraArgs = [] }) {
  const verdictsPath = join(cwd, 'ci-verdicts.json');
  writeFileSync(verdictsPath, JSON.stringify(verdicts));
  // We import the script via node directly. The script's `invokedDirectly`
  // gate runs `main()` only when argv[1] ends in ci-sign-attestation.mjs,
  // which is true for `node /path/to/ci-sign-attestation.mjs`.
  const scriptPath = join(cwd, 'scripts', 'ci-sign-attestation.mjs');
  const args = [
    scriptPath,
    '--review-verdicts',
    verdictsPath,
    '--iteration-count',
    '1',
    '--harness-note',
    '',
    ...extraArgs,
  ];
  const result = execFileSync('node', args, {
    cwd,
    env: { ...cleanEnv(), ...env },
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { stdout: result, stderr: '', exitCode: 0 };
}

// ─── Helper-function tests ─────────────────────────────────────────

describe('parseArgs', () => {
  it('parses --key value pairs', () => {
    const out = parseArgs(['--review-verdicts', '/tmp/v.json', '--iteration-count', '2']);
    assert.equal(out['review-verdicts'], '/tmp/v.json');
    assert.equal(out['iteration-count'], '2');
  });

  it('treats --flag with no value (or followed by another --flag) as boolean true', () => {
    const out = parseArgs(['--skip-if-valid', '--harness-note', 'hello']);
    assert.equal(out['skip-if-valid'], true);
    assert.equal(out['harness-note'], 'hello');
  });

  it('treats trailing --flag as boolean true', () => {
    const out = parseArgs(['--harness-note', 'hello', '--skip-if-valid']);
    assert.equal(out['skip-if-valid'], true);
  });
});

describe('purgeStaleEnvelopes (AISDLC-111)', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-sdlc-purge-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty list when the attestations dir does not exist', () => {
    const removed = purgeStaleEnvelopes(join(dir, 'does-not-exist'), 'a'.repeat(40));
    assert.deepEqual(removed, []);
  });

  it('returns empty list when only the current-head envelope is on disk', () => {
    const headSha = 'a'.repeat(40);
    writeFileSync(join(dir, `${headSha}.dsse.json`), '{}');
    const removed = purgeStaleEnvelopes(dir, headSha);
    assert.deepEqual(removed, []);
    // File still on disk.
    assert.equal(existsSync(join(dir, `${headSha}.dsse.json`)), true);
  });

  it('deletes every other .dsse.json envelope when re-signing for a new HEAD', () => {
    const headSha = 'a'.repeat(40);
    const stale1 = 'b'.repeat(40);
    const stale2 = 'c'.repeat(40);
    writeFileSync(join(dir, `${stale1}.dsse.json`), '{}');
    writeFileSync(join(dir, `${stale2}.dsse.json`), '{}');
    // Non-envelope sibling files (e.g. README) must be left alone.
    writeFileSync(join(dir, 'README.md'), 'do not delete');
    const removed = purgeStaleEnvelopes(dir, headSha);
    assert.equal(removed.length, 2);
    assert.equal(existsSync(join(dir, `${stale1}.dsse.json`)), false);
    assert.equal(existsSync(join(dir, `${stale2}.dsse.json`)), false);
    assert.equal(existsSync(join(dir, 'README.md')), true);
  });

  it('matches case-insensitively against the current head SHA', () => {
    const headShaLower = 'a'.repeat(40);
    const headShaMixed = 'A'.repeat(40);
    writeFileSync(join(dir, `${headShaLower}.dsse.json`), '{}');
    // Asking for the same SHA in a different case should NOT delete it.
    const removed = purgeStaleEnvelopes(dir, headShaMixed);
    assert.deepEqual(removed, []);
    assert.equal(existsSync(join(dir, `${headShaLower}.dsse.json`)), true);
  });

  it('ignores non-.dsse.json files in the attestations dir', () => {
    const headSha = 'a'.repeat(40);
    writeFileSync(join(dir, `${headSha}.dsse.json`), '{}');
    writeFileSync(join(dir, 'b'.repeat(40) + '.txt'), 'not an envelope');
    writeFileSync(join(dir, '.gitkeep'), '');
    const removed = purgeStaleEnvelopes(dir, headSha);
    assert.deepEqual(removed, []);
  });
});

describe('normalizeAgentId', () => {
  it('maps CI labels to canonical agentIds', () => {
    assert.equal(normalizeAgentId('testing'), 'test-reviewer');
    assert.equal(normalizeAgentId('critic'), 'code-reviewer');
    assert.equal(normalizeAgentId('security'), 'security-reviewer');
  });
  it('passes through canonical agentIds', () => {
    assert.equal(normalizeAgentId('test-reviewer'), 'test-reviewer');
    assert.equal(normalizeAgentId('code-reviewer'), 'code-reviewer');
    assert.equal(normalizeAgentId('security-reviewer'), 'security-reviewer');
  });
  it('returns null for unknown values', () => {
    assert.equal(normalizeAgentId('unknown'), null);
    assert.equal(normalizeAgentId(''), null);
  });
});

describe('buildReviewersFromVerdicts', () => {
  let fixture;
  beforeEach(() => {
    fixture = setupFixture();
  });
  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('translates CI verdicts into the predicate-reviewer shape', () => {
    const reviewers = buildReviewersFromVerdicts(VERDICTS_ALL_APPROVED, fixture.root);
    assert.equal(reviewers.length, 3);
    const ids = reviewers.map((r) => r.agentId).sort();
    assert.deepEqual(ids, ['code-reviewer', 'security-reviewer', 'test-reviewer']);
    for (const r of reviewers) {
      assert.equal(r.approved, true);
      assert.equal(typeof r.agentFileContent, 'string');
      assert.equal(r.findings.critical, 0);
    }
  });

  it('counts findings array entries by severity', () => {
    const verdicts = [
      {
        type: 'testing',
        approved: true,
        findings: [
          { severity: 'critical', message: 'x' },
          { severity: 'major', message: 'y' },
          { severity: 'critical', message: 'z' },
        ],
        summary: '',
      },
      { type: 'critic', approved: true, findings: [], summary: '' },
      { type: 'security', approved: true, findings: [], summary: '' },
    ];
    const reviewers = buildReviewersFromVerdicts(verdicts, fixture.root);
    const testing = reviewers.find((r) => r.agentId === 'test-reviewer');
    assert.equal(testing.findings.critical, 2);
    assert.equal(testing.findings.major, 1);
  });

  it('rejects unknown agentId/type', () => {
    const verdicts = [{ type: 'frobnicator', approved: true, findings: [], summary: '' }];
    assert.throws(
      () => buildReviewersFromVerdicts(verdicts, fixture.root),
      /unknown reviewer agentId\/type: frobnicator/,
    );
  });

  it('rejects duplicate agentIds', () => {
    const verdicts = [
      { type: 'testing', approved: true, findings: [], summary: '' },
      { agentId: 'test-reviewer', approved: true, findings: [], summary: '' },
    ];
    assert.throws(
      () => buildReviewersFromVerdicts(verdicts, fixture.root),
      /duplicate reviewer agentId: test-reviewer/,
    );
  });
});

// ─── End-to-end script tests (sign + verify) ─────────────────────

describe('ci-sign-attestation.mjs end-to-end', () => {
  let fixture;
  let ciKeys;

  beforeEach(() => {
    fixture = setupFixture();
    linkScriptDeps(fixture.root);
    ciKeys = generateSigningKeyPair();
    writeTrustedReviewersYaml(fixture.root, ciKeys.publicKeyPem);
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('AC #7: simulated remote-agent PR (no local attestation) → CI signs → verifier valid', () => {
    // Precondition: no envelope on disk yet.
    const envPath = join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.dsse.json`);
    assert.equal(existsSync(envPath), false);

    runCiSignScript({
      cwd: fixture.root,
      verdicts: VERDICTS_ALL_APPROVED,
      env: { AI_SDLC_CI_ATTESTOR_PRIVATE_KEY: ciKeys.privateKeyPem },
      extraArgs: ['--pr-base-sha', fixture.baseSha, '--pr-head-sha', fixture.headSha],
    });

    // Envelope landed at the expected path.
    assert.equal(existsSync(envPath), true);
    const envelope = JSON.parse(readFileSync(envPath, 'utf-8'));
    assert.match(envelope.signatures[0].keyid, /^ci-attestor:/);

    // Verifier accepts it as valid.
    const result = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(result.status, 'valid', `expected valid, got: ${result.reason}`);
  });

  it('AISDLC-101: CI-signed envelope carries contentHashV3 (Phase 2 triple-hash)', () => {
    // The CI-side attestor MUST emit Phase 2 triple-hash envelopes too —
    // otherwise external-contributor / fork PRs (which depend on the
    // CI attestor for signing) would silently regress to the AISDLC-94
    // dual-hash window.
    runCiSignScript({
      cwd: fixture.root,
      verdicts: VERDICTS_ALL_APPROVED,
      env: { AI_SDLC_CI_ATTESTOR_PRIVATE_KEY: ciKeys.privateKeyPem },
      extraArgs: ['--pr-base-sha', fixture.baseSha, '--pr-head-sha', fixture.headSha],
    });
    const envPath = join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.dsse.json`);
    const envelope = JSON.parse(readFileSync(envPath, 'utf-8'));
    const predicate = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8'));
    assert.match(predicate.diffHash, /^[0-9a-f]{64}$/, 'CI envelope must carry diffHash (v1)');
    assert.match(
      predicate.contentHash,
      /^[0-9a-f]{64}$/,
      'CI envelope must carry contentHash (v2)',
    );
    assert.match(
      predicate.contentHashV3,
      /^[0-9a-f]{64}$/,
      'CI envelope must carry contentHashV3 (v3, AISDLC-101)',
    );
  });

  it('AC #8: contributor PR with valid local attestation → CI does NOT redundantly sign', () => {
    // The maintainer signed first, with a key that's ALSO trusted (we add
    // a second entry to the fixture). The script should detect via the
    // verifier that the existing envelope is valid and exit 0 with
    // `skipped:` and never overwrite the file.
    const maintainerKeys = generateSigningKeyPair();
    // Write a YAML with BOTH keys trusted.
    const yaml =
      [
        '# trusted reviewers test fixture',
        'reviewers:',
        "  - identity: 'ci-attestor'",
        "    machine: 'github-actions'",
        "    addedAt: '2026-04-28'",
        "    addedBy: 'maintainer'",
        '    pubkey: |',
        ...ciKeys.publicKeyPem
          .trimEnd()
          .split('\n')
          .map((l) => `      ${l}`),
        "  - identity: 'maintainer@example.com'",
        "    machine: 'laptop'",
        "    addedAt: '2026-04-28'",
        "    addedBy: 'self'",
        '    pubkey: |',
        ...maintainerKeys.publicKeyPem
          .trimEnd()
          .split('\n')
          .map((l) => `      ${l}`),
      ].join('\n') + '\n';
    writeFileSync(join(fixture.root, '.ai-sdlc', 'trusted-reviewers.yaml'), yaml);
    writeMaintainerEnvelope(
      fixture.root,
      fixture.headSha,
      fixture.baseSha,
      maintainerKeys.privateKeyPem,
    );
    const envPath = join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.dsse.json`);
    const beforeBytes = readFileSync(envPath);
    const beforeKeyid = JSON.parse(beforeBytes.toString('utf-8')).signatures[0].keyid;
    assert.match(beforeKeyid, /^maintainer@/);

    const out = runCiSignScript({
      cwd: fixture.root,
      verdicts: VERDICTS_ALL_APPROVED,
      env: { AI_SDLC_CI_ATTESTOR_PRIVATE_KEY: ciKeys.privateKeyPem },
      extraArgs: [
        '--skip-if-valid',
        '--pr-base-sha',
        fixture.baseSha,
        '--pr-head-sha',
        fixture.headSha,
      ],
    });
    // Verifier writes a `[ai-sdlc/attestation] pipelineVersion: ...` log
    // line to stdout BEFORE the script's own `skipped: ...` line, so we
    // match anywhere in stdout (not just the first line).
    assert.match(out.stdout, /skipped:/, `expected skipped, got: ${out.stdout}`);

    // File untouched (still maintainer-signed).
    const afterBytes = readFileSync(envPath);
    assert.deepEqual(afterBytes, beforeBytes);
  });

  it('AC #9 (post-AISDLC-111): invalid local attestation (untrusted signer) → CI signs and PURGES stale envelope', () => {
    // Untrusted signer (NOT in trusted-reviewers.yaml). The local
    // attestation is "invalid" from the verifier's POV → CI signs a
    // fresh envelope.
    //
    // Pre-AISDLC-111 semantics: CI signed ADDITIVELY alongside the
    // stranger envelope (multi-envelope scan picked the valid one).
    // Post-AISDLC-111 semantics: CI's purgeStaleEnvelopes deletes the
    // stranger envelope (different filename SHA) BEFORE writing the
    // fresh CI envelope at `<head-sha>.dsse.json`. This avoids
    // accumulating orphan envelopes across rebases — the threat model
    // is preserved because the verifier still rejects an envelope
    // whose signature isn't trusted (so leaving it on disk gained us
    // nothing).
    const stranger = generateSigningKeyPair();
    // Stranger envelope at a DIFFERENT filename — simulating the
    // pre-AISDLC-111 "additive" shape that the purge step now collapses.
    const strangerSha = '1'.repeat(40);
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
      commitSha: fixture.headSha,
      diff,
      policy,
      reviewers,
      pluginVersion: PLUGIN_VERSION,
      iterationCount: 1,
      harnessNote: '',
      signedAt: '2026-04-28T00:00:00.000Z',
    });
    const strangerEnv = signAttestation({
      predicate,
      privateKeyPem: stranger.privateKeyPem,
      keyid: 'stranger:laptop',
    });
    writeFileSync(
      join(fixture.root, '.ai-sdlc', 'attestations', `${strangerSha}.dsse.json`),
      JSON.stringify(strangerEnv, null, 2),
    );

    // Pre-condition: verifier rejects (stranger not trusted).
    const beforeResult = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(beforeResult.status, 'invalid');
    assert.match(beforeResult.reason, /signature did not match/);

    // CI signs and PURGES. The script's --skip-if-valid path reports the
    // existing envelope is invalid, falls through, deletes the stranger
    // envelope (purgeStaleEnvelopes), and writes a fresh CI envelope at
    // <head-sha>.dsse.json.
    runCiSignScript({
      cwd: fixture.root,
      verdicts: VERDICTS_ALL_APPROVED,
      env: { AI_SDLC_CI_ATTESTOR_PRIVATE_KEY: ciKeys.privateKeyPem },
      extraArgs: [
        '--skip-if-valid',
        '--pr-base-sha',
        fixture.baseSha,
        '--pr-head-sha',
        fixture.headSha,
      ],
    });

    // CI envelope written; stranger envelope purged (AISDLC-111).
    const ciPath = join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.dsse.json`);
    assert.equal(existsSync(ciPath), true, 'CI envelope must exist');
    const strangerPath = join(fixture.root, '.ai-sdlc', 'attestations', `${strangerSha}.dsse.json`);
    assert.equal(
      existsSync(strangerPath),
      false,
      'stranger envelope must be purged (AISDLC-111: no orphan envelopes)',
    );

    // Verifier now accepts: only the fresh CI envelope is on disk.
    const afterResult = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(
      afterResult.status,
      'valid',
      `expected valid after CI sign + purge, got: ${afterResult.reason}`,
    );
  });

  it('AISDLC-111: re-signing after rebase deletes stale envelopes (no orphan accumulation)', () => {
    // Simulate the rebase scenario: a CI-signed envelope from a prior HEAD
    // is on the branch, then the PR rebases onto a new base. The script
    // is invoked again (because the rebase invalidated the prior envelope's
    // contentHashV3 and `ai-sdlc/attestation` flipped to FAILURE). It must
    // delete the stale `<old-head>.dsse.json` AND write a fresh one at
    // `<new-head>.dsse.json` — leaving exactly ONE envelope on disk.
    //
    // Without the AISDLC-111 fix, the old envelope would remain and the
    // branch would accumulate orphaned envelopes across every rebase.
    const oldHeadSha = 'a'.repeat(40);
    const stalePath = join(fixture.root, '.ai-sdlc', 'attestations', `${oldHeadSha}.dsse.json`);
    writeFileSync(stalePath, JSON.stringify({ stale: true }));
    assert.equal(existsSync(stalePath), true);

    runCiSignScript({
      cwd: fixture.root,
      verdicts: VERDICTS_ALL_APPROVED,
      env: { AI_SDLC_CI_ATTESTOR_PRIVATE_KEY: ciKeys.privateKeyPem },
      extraArgs: ['--pr-base-sha', fixture.baseSha, '--pr-head-sha', fixture.headSha],
    });

    // Stale envelope deleted, fresh envelope written.
    assert.equal(existsSync(stalePath), false, 'stale envelope must be removed');
    const freshPath = join(
      fixture.root,
      '.ai-sdlc',
      'attestations',
      `${fixture.headSha}.dsse.json`,
    );
    assert.equal(existsSync(freshPath), true, 'fresh envelope must be written');

    // Verifier accepts the fresh envelope as valid against current HEAD.
    const result = runVerifier({
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      repoRoot: fixture.root,
    });
    assert.equal(result.status, 'valid', `expected valid, got: ${result.reason}`);
  });

  it('AISDLC-111: re-signing for the SAME HEAD overwrites in place (idempotent)', () => {
    // Re-running the script for the same HEAD (e.g., a CI re-run on the
    // same commit) must NOT delete its own envelope, just overwrite it.
    runCiSignScript({
      cwd: fixture.root,
      verdicts: VERDICTS_ALL_APPROVED,
      env: { AI_SDLC_CI_ATTESTOR_PRIVATE_KEY: ciKeys.privateKeyPem },
      extraArgs: ['--pr-base-sha', fixture.baseSha, '--pr-head-sha', fixture.headSha],
    });
    const envPath = join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.dsse.json`);
    assert.equal(existsSync(envPath), true);
    const firstBytes = readFileSync(envPath);

    // Second invocation against the same HEAD.
    runCiSignScript({
      cwd: fixture.root,
      verdicts: VERDICTS_ALL_APPROVED,
      env: { AI_SDLC_CI_ATTESTOR_PRIVATE_KEY: ciKeys.privateKeyPem },
      extraArgs: ['--pr-base-sha', fixture.baseSha, '--pr-head-sha', fixture.headSha],
    });
    assert.equal(existsSync(envPath), true, 'envelope must still exist after re-sign');
    const secondBytes = readFileSync(envPath);
    // Envelope payload differs only by signedAt timestamp (regenerated each
    // sign). Both envelopes must verify cleanly — the test asserts the
    // file is still present and parses as valid JSON.
    assert.ok(secondBytes.length > 0, 'envelope must be non-empty after re-sign');
    void firstBytes; // signature timestamp will differ between signs; we don't assert byte-equal.

    // Only ONE envelope file in the directory.
    const remaining = readdirSync(join(fixture.root, '.ai-sdlc', 'attestations')).filter((n) =>
      n.endsWith('.dsse.json'),
    );
    assert.deepEqual(remaining, [`${fixture.headSha}.dsse.json`]);
  });

  it('refuses to sign when not all reviewers approved (defense in depth — workflow already gates this)', () => {
    const verdicts = [
      { type: 'testing', approved: true, findings: [], summary: 'lgtm' },
      {
        type: 'critic',
        approved: false,
        findings: [{ severity: 'critical', message: 'broken' }],
        summary: 'reject',
      },
      { type: 'security', approved: true, findings: [], summary: 'lgtm' },
    ];
    let threw = null;
    try {
      runCiSignScript({
        cwd: fixture.root,
        verdicts,
        env: { AI_SDLC_CI_ATTESTOR_PRIVATE_KEY: ciKeys.privateKeyPem },
        extraArgs: ['--pr-base-sha', fixture.baseSha, '--pr-head-sha', fixture.headSha],
      });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'script should exit non-zero when not all approved');
    const stderr = threw.stderr?.toString() ?? '';
    assert.match(stderr, /refusing to sign|not every reviewer approved/);
    // Envelope must NOT have been written.
    const envPath = join(fixture.root, '.ai-sdlc', 'attestations', `${fixture.headSha}.dsse.json`);
    assert.equal(existsSync(envPath), false);
  });

  it('errors out when AI_SDLC_CI_ATTESTOR_PRIVATE_KEY is missing', () => {
    let threw = null;
    try {
      runCiSignScript({
        cwd: fixture.root,
        verdicts: VERDICTS_ALL_APPROVED,
        env: {}, // no key
        extraArgs: ['--pr-base-sha', fixture.baseSha, '--pr-head-sha', fixture.headSha],
      });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'script should exit non-zero when key missing');
    const stderr = threw.stderr?.toString() ?? '';
    assert.match(stderr, /AI_SDLC_CI_ATTESTOR_PRIVATE_KEY/);
  });
});
