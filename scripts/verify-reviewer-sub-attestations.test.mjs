/**
 * Tests for `scripts/verify-reviewer-sub-attestations.mjs` — AISDLC-380.
 *
 * Hermetic regression test reproducing the 2026-05-20 incident (AC #6):
 * a dev subagent wrote a hand-crafted verdict file with `approved: true`
 * entries and no sub-attestation block. The pre-push hook MUST refuse to
 * sign with exit code 1 + non-empty stderr naming the missing sub-attestations.
 *
 * Also tests: valid sub-attestation verification, content-hash mismatch,
 * unknown-signer rejection, and the AI_SDLC_LEGACY_VERDICTS=1 escape hatch.
 *
 * Run with: node --test scripts/verify-reviewer-sub-attestations.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'verify-reviewer-sub-attestations.mjs');
const SIGN_REVIEWER_VERDICT = join(
  __dirname,
  '..',
  'ai-sdlc-plugin',
  'scripts',
  'sign-reviewer-verdict.mjs',
);

function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  }
  return value;
}

function canonicalVerdictHash(verdict) {
  return sha256Hex(JSON.stringify(sortKeysDeep(verdict)));
}

/**
 * Generate a fresh ed25519 keypair for a reviewer in a temp dir.
 * Returns { privateKeyPem, publicKeyPem }.
 */
function generateReviewerKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

/**
 * Build a valid sub-attestation for a reviewer using the given private key.
 */
function buildSubAttestation({ reviewerName, taskId, verdict, privateKeyPem }) {
  const contentHash = canonicalVerdictHash(verdict);
  const signedPayload = JSON.stringify({
    reviewerName,
    taskId: taskId.toUpperCase(),
    contentHash,
  });
  const sigBytes = sign(null, Buffer.from(signedPayload, 'utf-8'), privateKeyPem);
  return {
    reviewerName,
    taskId: taskId.toUpperCase(),
    verdict,
    contentHash,
    signature: sigBytes.toString('base64'),
    signedAt: new Date().toISOString(),
    keyid: `reviewer:${reviewerName}:testmachine`,
  };
}

/**
 * Build a minimal trusted-reviewers.yaml with reviewer entries.
 * entries: [{ reviewerName, publicKeyPem }]
 */
function buildTrustedReviewersYaml(entries) {
  let yaml = `# Test trusted-reviewers.yaml\nreviewers:\n`;
  for (const { reviewerName, publicKeyPem } of entries) {
    yaml += `  - type: 'reviewer'\n`;
    yaml += `    reviewer: '${reviewerName}'\n`;
    yaml += `    machine: 'testmachine'\n`;
    yaml += `    addedAt: '2026-05-20'\n`;
    yaml += `    addedBy: 'test'\n`;
    yaml += `    pubkey: |\n`;
    for (const line of publicKeyPem.trimEnd().split('\n')) {
      yaml += `      ${line}\n`;
    }
  }
  return yaml;
}

function runVerifier(args, env = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env, AI_SDLC_LEGACY_VERDICTS: env.AI_SDLC_LEGACY_VERDICTS ?? '' },
  });
}

describe('verify-reviewer-sub-attestations.mjs (AISDLC-380)', () => {
  let tmpDir;
  let verdictPath;
  let reviewersYamlPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-sub-att-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── AC #6: HERMETIC REGRESSION — 2026-05-20 incident ────────────────────
  //
  // Dev subagent writes a hand-crafted verdict file with approved:true
  // for all reviewers but no sub-attestation block. The verifier MUST
  // refuse with exit code 1 and name the missing sub-attestations.

  it('AC#6 regression: plain-JSON legacy verdict → exits 1 with reviewer names in stderr', () => {
    // This reproduces the exact verdict file shape a dev subagent would write
    // when forging approval (the 2026-05-20 incident pattern).
    const forgeryPath = join(tmpDir, 'aisdlc-380.json');
    writeFileSync(
      forgeryPath,
      JSON.stringify(
        [
          {
            agentId: 'code-reviewer',
            harness: 'claude-code',
            approved: true,
            findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
            summary: 'LGTM',
          },
          {
            agentId: 'test-reviewer',
            harness: 'claude-code',
            approved: true,
            findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
            summary: 'All tests pass',
          },
          {
            agentId: 'security-reviewer',
            harness: 'claude-code',
            approved: true,
            findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
            summary: 'No vulnerabilities found',
          },
        ],
        null,
        2,
      ),
    );

    // Minimal trusted-reviewers.yaml (no reviewer entries — op hasn't set them up yet).
    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(
      reviewersYaml,
      `# empty\nreviewers:\n  - identity: 'test@test.com'\n    machine: 'testmachine'\n    addedAt: '2026-05-20'\n    addedBy: 'test'\n    pubkey: |\n      -----BEGIN PUBLIC KEY-----\n      MCowBQYDK2VwAyEA7RfNqQjnRnt7dG0gjIWIkqyfvn+/aMycmbaEbq7lS7E=\n      -----END PUBLIC KEY-----\n`,
    );

    const r = runVerifier([
      '--verdict-file',
      forgeryPath,
      '--task-id',
      'AISDLC-380',
      '--trusted-reviewers',
      reviewersYaml,
    ]);

    // Exit code 1 = verification failed.
    assert.equal(
      r.status,
      1,
      `expected exit 1 (forge detected), got ${r.status}: stderr=${r.stderr}`,
    );

    // stderr must name the missing sub-attestations.
    assert.match(
      r.stderr,
      /legacy plain-JSON/i,
      `stderr must mention "legacy plain-JSON": ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /code-reviewer|test-reviewer|security-reviewer/i,
      `stderr must name at least one reviewer: ${r.stderr}`,
    );

    // stderr must mention the escape hatch.
    assert.match(
      r.stderr,
      /AI_SDLC_LEGACY_VERDICTS=1/,
      `stderr must mention the escape hatch: ${r.stderr}`,
    );
  });

  it('AC#6: plain-JSON verdict with AI_SDLC_LEGACY_VERDICTS=1 → exits 0 with warning', () => {
    const forgeryPath = join(tmpDir, 'aisdlc-380.json');
    writeFileSync(
      forgeryPath,
      JSON.stringify([
        {
          agentId: 'code-reviewer',
          harness: 'claude-code',
          approved: true,
          findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
          summary: 'LGTM',
        },
      ]),
    );
    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(reviewersYaml, `reviewers:\n`);

    const r = runVerifier(
      [
        '--verdict-file',
        forgeryPath,
        '--task-id',
        'AISDLC-380',
        '--trusted-reviewers',
        reviewersYaml,
      ],
      { AI_SDLC_LEGACY_VERDICTS: '1' },
    );

    assert.equal(r.status, 0, `expected exit 0 (legacy mode), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /legacy/i, `stderr must mention legacy mode: ${r.stderr}`);
    assert.match(
      r.stderr,
      /AI_SDLC_LEGACY_VERDICTS=1/,
      `stderr must confirm legacy mode was active: ${r.stderr}`,
    );
  });

  // ── Valid sub-attestation path ───────────────────────────────────────────

  it('valid sub-attestations → exits 0', () => {
    const { privateKeyPem: codePriv, publicKeyPem: codePub } = generateReviewerKeypair();
    const { privateKeyPem: testPriv, publicKeyPem: testPub } = generateReviewerKeypair();
    const { privateKeyPem: secPriv, publicKeyPem: secPub } = generateReviewerKeypair();

    const taskId = 'AISDLC-380';

    const codeVerdict = { approved: true, findings: [], summary: 'Code LGTM' };
    const testVerdict = { approved: true, findings: [], summary: 'Tests cover new paths' };
    const secVerdict = { approved: true, findings: [], summary: 'No security issues' };

    const subAttestations = [
      buildSubAttestation({
        reviewerName: 'code-reviewer',
        taskId,
        verdict: codeVerdict,
        privateKeyPem: codePriv,
      }),
      buildSubAttestation({
        reviewerName: 'test-reviewer',
        taskId,
        verdict: testVerdict,
        privateKeyPem: testPriv,
      }),
      buildSubAttestation({
        reviewerName: 'security-reviewer',
        taskId,
        verdict: secVerdict,
        privateKeyPem: secPriv,
      }),
    ];

    const verdictPath = join(tmpDir, 'aisdlc-380.json');
    writeFileSync(verdictPath, JSON.stringify({ taskId, subAttestations }, null, 2));

    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(
      reviewersYaml,
      buildTrustedReviewersYaml([
        { reviewerName: 'code-reviewer', publicKeyPem: codePub },
        { reviewerName: 'test-reviewer', publicKeyPem: testPub },
        { reviewerName: 'security-reviewer', publicKeyPem: secPub },
      ]),
    );

    const r = runVerifier([
      '--verdict-file',
      verdictPath,
      '--task-id',
      taskId,
      '--trusted-reviewers',
      reviewersYaml,
    ]);

    assert.equal(r.status, 0, `expected exit 0 (valid), got ${r.status}: stderr=${r.stderr}`);
    assert.match(
      r.stderr,
      /verified 3/i,
      `stderr must confirm 3 sub-attestations verified: ${r.stderr}`,
    );
  });

  it('sub-attestation with wrong taskId → exits 1', () => {
    const { privateKeyPem: priv, publicKeyPem: pub } = generateReviewerKeypair();
    const verdict = { approved: true, findings: [], summary: 'LGTM' };

    // Sign for AISDLC-999, not AISDLC-380.
    const subAtt = buildSubAttestation({
      reviewerName: 'code-reviewer',
      taskId: 'AISDLC-999',
      verdict,
      privateKeyPem: priv,
    });
    // Override taskId in the envelope to AISDLC-380 but keep signature
    // binding to AISDLC-999 (tampered).
    subAtt.taskId = 'AISDLC-380';

    const verdictPath = join(tmpDir, 'aisdlc-380.json');
    writeFileSync(verdictPath, JSON.stringify([subAtt]));

    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(
      reviewersYaml,
      buildTrustedReviewersYaml([{ reviewerName: 'code-reviewer', publicKeyPem: pub }]),
    );

    const r = runVerifier([
      '--verdict-file',
      verdictPath,
      '--task-id',
      'AISDLC-380',
      '--trusted-reviewers',
      reviewersYaml,
    ]);

    assert.equal(r.status, 1, `expected exit 1 (sig mismatch), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /ERROR/i, `stderr must indicate error: ${r.stderr}`);
  });

  it('sub-attestation with tampered verdict → content hash mismatch → exits 1', () => {
    const { privateKeyPem: priv, publicKeyPem: pub } = generateReviewerKeypair();
    const verdict = { approved: true, findings: [], summary: 'LGTM' };
    const subAtt = buildSubAttestation({
      reviewerName: 'code-reviewer',
      taskId: 'AISDLC-380',
      verdict,
      privateKeyPem: priv,
    });
    // Tamper the verdict inside the sub-attestation after signing.
    subAtt.verdict = { approved: true, findings: [], summary: 'LGTM — tampered' };

    const verdictPath = join(tmpDir, 'aisdlc-380.json');
    writeFileSync(verdictPath, JSON.stringify([subAtt]));

    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(
      reviewersYaml,
      buildTrustedReviewersYaml([{ reviewerName: 'code-reviewer', publicKeyPem: pub }]),
    );

    const r = runVerifier([
      '--verdict-file',
      verdictPath,
      '--task-id',
      'AISDLC-380',
      '--trusted-reviewers',
      reviewersYaml,
    ]);

    assert.equal(r.status, 1, `expected exit 1 (tampered verdict), got ${r.status}: ${r.stderr}`);
    assert.match(
      r.stderr,
      /contentHash mismatch|tampered/i,
      `stderr must name the issue: ${r.stderr}`,
    );
  });

  it('sub-attestation signed by unknown key → exits 1', () => {
    const { privateKeyPem: priv } = generateReviewerKeypair();
    const { publicKeyPem: wrongPub } = generateReviewerKeypair(); // Different keypair!

    const verdict = { approved: true, findings: [], summary: 'LGTM' };
    const subAtt = buildSubAttestation({
      reviewerName: 'code-reviewer',
      taskId: 'AISDLC-380',
      verdict,
      privateKeyPem: priv,
    });

    const verdictPath = join(tmpDir, 'aisdlc-380.json');
    writeFileSync(verdictPath, JSON.stringify([subAtt]));

    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    // Registry has a DIFFERENT pubkey for code-reviewer.
    writeFileSync(
      reviewersYaml,
      buildTrustedReviewersYaml([{ reviewerName: 'code-reviewer', publicKeyPem: wrongPub }]),
    );

    const r = runVerifier([
      '--verdict-file',
      verdictPath,
      '--task-id',
      'AISDLC-380',
      '--trusted-reviewers',
      reviewersYaml,
    ]);

    assert.equal(r.status, 1, `expected exit 1 (wrong key), got ${r.status}: ${r.stderr}`);
    assert.match(
      r.stderr,
      /does not match any trusted pubkey|ERROR/i,
      `stderr must indicate signature mismatch: ${r.stderr}`,
    );
  });

  it('no reviewer entry in registry → exits 1 with helpful message', () => {
    const { privateKeyPem: priv } = generateReviewerKeypair();

    const verdict = { approved: true, findings: [], summary: 'LGTM' };
    const subAtt = buildSubAttestation({
      reviewerName: 'code-reviewer',
      taskId: 'AISDLC-380',
      verdict,
      privateKeyPem: priv,
    });

    const verdictPath = join(tmpDir, 'aisdlc-380.json');
    writeFileSync(verdictPath, JSON.stringify([subAtt]));

    // Only has an operator entry, no reviewer entries.
    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(
      reviewersYaml,
      `reviewers:\n  - identity: 'op@example.com'\n    machine: 'laptop'\n    addedAt: '2026-05-20'\n    addedBy: 'test'\n    pubkey: |\n      -----BEGIN PUBLIC KEY-----\n      MCowBQYDK2VwAyEA7RfNqQjnRnt7dG0gjIWIkqyfvn+/aMycmbaEbq7lS7E=\n      -----END PUBLIC KEY-----\n`,
    );

    const r = runVerifier([
      '--verdict-file',
      verdictPath,
      '--task-id',
      'AISDLC-380',
      '--trusted-reviewers',
      reviewersYaml,
    ]);

    assert.equal(r.status, 1, `expected exit 1 (no registry entry), got ${r.status}: ${r.stderr}`);
    assert.match(
      r.stderr,
      /no matching entry|trusted-reviewers\.yaml/i,
      `stderr must explain how to fix: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /init-reviewer-signing-key/i,
      `stderr must mention the key init command: ${r.stderr}`,
    );
  });

  it('missing --verdict-file → exits 2 with error', () => {
    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(reviewersYaml, 'reviewers:\n');

    const r = runVerifier(['--task-id', 'AISDLC-380', '--trusted-reviewers', reviewersYaml]);

    assert.equal(r.status, 2, `expected exit 2 (args error), got ${r.status}: ${r.stderr}`);
  });

  it('missing --task-id → exits 2 with error', () => {
    const verdictPath = join(tmpDir, 'aisdlc-380.json');
    writeFileSync(verdictPath, '[]');
    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(reviewersYaml, 'reviewers:\n');

    const r = runVerifier(['--verdict-file', verdictPath, '--trusted-reviewers', reviewersYaml]);

    assert.equal(r.status, 2, `expected exit 2 (args error), got ${r.status}: ${r.stderr}`);
  });

  // ── Bug #1: empty subAttestations bypass ─────────────────────────────────
  //
  // { taskId, subAttestations: [] } is classified as non-legacy but was
  // exiting 0 with "verified 0 sub-attestations — all OK". This reproduces
  // the 2026-05-20 forgery class via the new envelope shape.

  it('Bug#1: empty subAttestations with registry reviewers → exits 1 naming missing reviewers', () => {
    const { publicKeyPem: codePub } = generateReviewerKeypair();
    const { publicKeyPem: testPub } = generateReviewerKeypair();

    const verdictPath = join(tmpDir, 'aisdlc-380.json');
    // New envelope shape but zero sub-attestations.
    writeFileSync(
      verdictPath,
      JSON.stringify({ taskId: 'AISDLC-380', subAttestations: [] }, null, 2),
    );

    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(
      reviewersYaml,
      buildTrustedReviewersYaml([
        { reviewerName: 'code-reviewer', publicKeyPem: codePub },
        { reviewerName: 'test-reviewer', publicKeyPem: testPub },
      ]),
    );

    const r = runVerifier([
      '--verdict-file',
      verdictPath,
      '--task-id',
      'AISDLC-380',
      '--trusted-reviewers',
      reviewersYaml,
    ]);

    assert.equal(
      r.status,
      1,
      `expected exit 1 (empty bypass rejected), got ${r.status}: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /code-reviewer|test-reviewer/i,
      `stderr must name the missing reviewers: ${r.stderr}`,
    );
    assert.match(r.stderr, /0 sub-attestations/i, `stderr must mention empty count: ${r.stderr}`);
  });

  it('Bug#1: empty subAttestations with no registry reviewers + no legacy mode → exits 1', () => {
    const verdictPath = join(tmpDir, 'aisdlc-380.json');
    writeFileSync(verdictPath, JSON.stringify({ taskId: 'AISDLC-380', subAttestations: [] }));

    // Only has an operator entry (no reviewer type entries).
    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(
      reviewersYaml,
      `reviewers:\n  - identity: 'op@example.com'\n    machine: 'laptop'\n    addedAt: '2026-05-20'\n    addedBy: 'test'\n    pubkey: |\n      -----BEGIN PUBLIC KEY-----\n      MCowBQYDK2VwAyEA7RfNqQjnRnt7dG0gjIWIkqyfvn+/aMycmbaEbq7lS7E=\n      -----END PUBLIC KEY-----\n`,
    );

    const r = runVerifier([
      '--verdict-file',
      verdictPath,
      '--task-id',
      'AISDLC-380',
      '--trusted-reviewers',
      reviewersYaml,
    ]);

    assert.equal(
      r.status,
      1,
      `expected exit 1 (no reviewers configured + no legacy mode), got ${r.status}: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /no reviewer entries|0 sub-attestations/i,
      `stderr must explain situation: ${r.stderr}`,
    );
  });

  it('Bug#1: empty subAttestations with no registry reviewers + AI_SDLC_LEGACY_VERDICTS=1 → exits 0', () => {
    const verdictPath = join(tmpDir, 'aisdlc-380.json');
    writeFileSync(verdictPath, JSON.stringify({ taskId: 'AISDLC-380', subAttestations: [] }));

    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(reviewersYaml, `reviewers:\n`);

    const r = runVerifier(
      [
        '--verdict-file',
        verdictPath,
        '--task-id',
        'AISDLC-380',
        '--trusted-reviewers',
        reviewersYaml,
      ],
      { AI_SDLC_LEGACY_VERDICTS: '1' },
    );

    assert.equal(
      r.status,
      0,
      `expected exit 0 (no reviewers configured + legacy mode), got ${r.status}: ${r.stderr}`,
    );
  });

  it('Bug#1: non-empty but incomplete subAttestations (missing reviewer) → exits 1', () => {
    const { privateKeyPem: codePriv, publicKeyPem: codePub } = generateReviewerKeypair();
    const { publicKeyPem: testPub } = generateReviewerKeypair();

    const taskId = 'AISDLC-380';
    const codeVerdict = { approved: true, findings: [], summary: 'Code LGTM' };
    const subAttestations = [
      buildSubAttestation({
        reviewerName: 'code-reviewer',
        taskId,
        verdict: codeVerdict,
        privateKeyPem: codePriv,
      }),
      // test-reviewer is missing
    ];

    const verdictPath = join(tmpDir, 'aisdlc-380.json');
    writeFileSync(verdictPath, JSON.stringify({ taskId, subAttestations }, null, 2));

    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(
      reviewersYaml,
      buildTrustedReviewersYaml([
        { reviewerName: 'code-reviewer', publicKeyPem: codePub },
        { reviewerName: 'test-reviewer', publicKeyPem: testPub },
      ]),
    );

    const r = runVerifier([
      '--verdict-file',
      verdictPath,
      '--task-id',
      taskId,
      '--trusted-reviewers',
      reviewersYaml,
    ]);

    assert.equal(r.status, 1, `expected exit 1 (incomplete), got ${r.status}: ${r.stderr}`);
    assert.match(
      r.stderr,
      /test-reviewer/i,
      `stderr must name the missing test-reviewer: ${r.stderr}`,
    );
  });

  // ── iter-3: duplicate-reviewerName bypass ────────────────────────────────
  //
  // code-reviewer iter-2 finding: the foundNames Set dedupes silently. If a
  // registry has only [code-reviewer] and the verdict file has two valid
  // code-reviewer sub-attestations, the completeness check passes with only
  // one reviewer actually running. Fix: reject when duplicate reviewerName
  // entries are present in the subAttestations array.

  it('iter-3: duplicate code-reviewer sub-attestations → exits 1 with duplicates named', () => {
    const { privateKeyPem: codePriv, publicKeyPem: codePub } = generateReviewerKeypair();

    const taskId = 'AISDLC-380';
    const codeVerdict = { approved: true, findings: [], summary: 'Code LGTM' };
    const oneAttestation = buildSubAttestation({
      reviewerName: 'code-reviewer',
      taskId,
      verdict: codeVerdict,
      privateKeyPem: codePriv,
    });
    // Submit TWO copies of the same valid sub-attestation. Without the
    // uniqueness check, foundNames = {'code-reviewer'} satisfies the
    // single-reviewer registry's completeness check.
    const subAttestations = [oneAttestation, oneAttestation];

    const verdictPath = join(tmpDir, 'aisdlc-380-dup.json');
    writeFileSync(verdictPath, JSON.stringify({ taskId, subAttestations }, null, 2));

    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(
      reviewersYaml,
      buildTrustedReviewersYaml([{ reviewerName: 'code-reviewer', publicKeyPem: codePub }]),
    );

    const r = runVerifier([
      '--verdict-file',
      verdictPath,
      '--task-id',
      taskId,
      '--trusted-reviewers',
      reviewersYaml,
    ]);

    assert.equal(r.status, 1, `expected exit 1 (duplicates), got ${r.status}: ${r.stderr}`);
    assert.match(
      r.stderr,
      /duplicate[\s\S]*code-reviewer/i,
      `stderr must name the duplicate reviewer: ${r.stderr}`,
    );
  });

  // ── Bug #7: taskId binding check coverage ─────────────────────────────────
  //
  // The existing "wrong taskId" test tampers the envelope's taskId field, which
  // means the sig mismatches and rejection happens at sig-verify, NOT at the
  // binding check. This test signs legitimately for AISDLC-380, then invokes the
  // verifier with --task-id AISDLC-999. Rejection MUST happen at the binding
  // check (line: attNormalized !== normalizedTaskId) before sig-verify.

  it('Bug#7: taskId binding check — legit AISDLC-380 sig rejected when verifier gets --task-id AISDLC-999', () => {
    const { privateKeyPem: priv, publicKeyPem: pub } = generateReviewerKeypair();
    const verdict = { approved: true, findings: [], summary: 'LGTM' };

    // Sign legitimately for AISDLC-380.
    const subAtt = buildSubAttestation({
      reviewerName: 'code-reviewer',
      taskId: 'AISDLC-380',
      verdict,
      privateKeyPem: priv,
    });

    const verdictPath = join(tmpDir, 'aisdlc-380.json');
    writeFileSync(verdictPath, JSON.stringify([subAtt]));

    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(
      reviewersYaml,
      buildTrustedReviewersYaml([{ reviewerName: 'code-reviewer', publicKeyPem: pub }]),
    );

    // Invoke verifier with AISDLC-999 — should reject at binding check.
    const r = runVerifier([
      '--verdict-file',
      verdictPath,
      '--task-id',
      'AISDLC-999', // ← different task
      '--trusted-reviewers',
      reviewersYaml,
    ]);

    assert.equal(
      r.status,
      1,
      `expected exit 1 (taskId binding mismatch), got ${r.status}: ${r.stderr}`,
    );
    // Error message must include BOTH task IDs so the operator can diagnose.
    assert.match(
      r.stderr,
      /AISDLC-380/i,
      `stderr must include the sub-attestation's bound taskId: ${r.stderr}`,
    );
    assert.match(r.stderr, /AISDLC-999/i, `stderr must include the expected taskId: ${r.stderr}`);
  });

  // ── Bug #8: security-reviewer unsigned-exempt path ────────────────────────
  //
  // security-reviewer declares disallowedTools: [Bash] so it cannot invoke the
  // sign helper. Option B: accept entries with unsigned: true, exemptReason: 'no-bash-tool'
  // ONLY for reviewerName === 'security-reviewer'. All other reviewers must be signed.

  it('Bug#8: security-reviewer unsigned-exempt entry → accepted alongside signed others', () => {
    const { privateKeyPem: codePriv, publicKeyPem: codePub } = generateReviewerKeypair();
    const { privateKeyPem: testPriv, publicKeyPem: testPub } = generateReviewerKeypair();

    const taskId = 'AISDLC-380';
    const codeVerdict = { approved: true, findings: [], summary: 'Code LGTM' };
    const testVerdict = { approved: true, findings: [], summary: 'Tests pass' };
    const secVerdict = { approved: true, findings: [], summary: 'No security issues' };

    const subAttestations = [
      buildSubAttestation({
        reviewerName: 'code-reviewer',
        taskId,
        verdict: codeVerdict,
        privateKeyPem: codePriv,
      }),
      buildSubAttestation({
        reviewerName: 'test-reviewer',
        taskId,
        verdict: testVerdict,
        privateKeyPem: testPriv,
      }),
      // security-reviewer is unsigned-exempt (no Bash tool)
      {
        reviewerName: 'security-reviewer',
        unsigned: true,
        exemptReason: 'no-bash-tool',
        verdict: secVerdict,
      },
    ];

    const verdictPath = join(tmpDir, 'aisdlc-380.json');
    writeFileSync(verdictPath, JSON.stringify({ taskId, subAttestations }, null, 2));

    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(
      reviewersYaml,
      buildTrustedReviewersYaml([
        { reviewerName: 'code-reviewer', publicKeyPem: codePub },
        { reviewerName: 'test-reviewer', publicKeyPem: testPub },
        // security-reviewer has no registry entry (it's always exempt)
      ]),
    );

    const r = runVerifier([
      '--verdict-file',
      verdictPath,
      '--task-id',
      taskId,
      '--trusted-reviewers',
      reviewersYaml,
    ]);

    assert.equal(
      r.status,
      0,
      `expected exit 0 (security-reviewer exempt accepted), got ${r.status}: ${r.stderr}`,
    );
  });

  it('Bug#8: non-security-reviewer claiming unsigned-exempt → rejected', () => {
    const { privateKeyPem: codePriv, publicKeyPem: codePub } = generateReviewerKeypair();
    const taskId = 'AISDLC-380';

    const subAttestations = [
      // code-reviewer trying to claim the security-reviewer exemption
      {
        reviewerName: 'code-reviewer',
        unsigned: true,
        exemptReason: 'no-bash-tool',
        verdict: { approved: true, findings: [], summary: 'LGTM' },
      },
    ];

    const verdictPath = join(tmpDir, 'aisdlc-380.json');
    writeFileSync(verdictPath, JSON.stringify({ taskId, subAttestations }, null, 2));

    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(
      reviewersYaml,
      buildTrustedReviewersYaml([{ reviewerName: 'code-reviewer', publicKeyPem: codePub }]),
    );

    const r = runVerifier([
      '--verdict-file',
      verdictPath,
      '--task-id',
      taskId,
      '--trusted-reviewers',
      reviewersYaml,
    ]);

    assert.equal(
      r.status,
      1,
      `expected exit 1 (only security-reviewer may claim exempt), got ${r.status}: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /only.*security-reviewer.*permitted|unsigned-exempt/i,
      `stderr must explain that only security-reviewer may claim exempt: ${r.stderr}`,
    );
  });

  // ── Bug #9: recursive canonical JSON sort (regression) ───────────────────
  //
  // A verdict with nested objects (e.g. findings array with objects) must be
  // sorted recursively so signer and verifier agree on the canonical hash
  // even when the schema gains nested objects.

  it('Bug#9: nested verdict object — signer and verifier agree on canonical hash', () => {
    const { privateKeyPem: priv, publicKeyPem: pub } = generateReviewerKeypair();
    const taskId = 'AISDLC-380';

    // Verdict with nested objects — keys deliberately out of alphabetical order.
    const verdict = {
      summary: 'Nested test',
      approved: true,
      findings: [{ severity: 'minor', message: 'test', file: 'foo.ts', line: 1 }],
      metadata: { reviewedAt: '2026-05-20', reviewer: 'code-reviewer' },
    };

    const subAtt = buildSubAttestation({
      reviewerName: 'code-reviewer',
      taskId,
      verdict,
      privateKeyPem: priv,
    });

    const verdictPath = join(tmpDir, 'aisdlc-380.json');
    writeFileSync(verdictPath, JSON.stringify([subAtt]));

    const reviewersYaml = join(tmpDir, 'trusted-reviewers.yaml');
    writeFileSync(
      reviewersYaml,
      buildTrustedReviewersYaml([{ reviewerName: 'code-reviewer', publicKeyPem: pub }]),
    );

    const r = runVerifier([
      '--verdict-file',
      verdictPath,
      '--task-id',
      taskId,
      '--trusted-reviewers',
      reviewersYaml,
    ]);

    assert.equal(
      r.status,
      0,
      `expected exit 0 (nested verdict canonical hash matches), got ${r.status}: ${r.stderr}`,
    );
    assert.match(r.stderr, /verified 1/i, `stderr must confirm verification: ${r.stderr}`);
  });

  // ── check-attestation-sign.sh integration: sub-attestation verification ─

  it('AC#6 integration (RFC-0042 Phase 3): v5 audit-only — check-attestation-sign.sh warns but does NOT block on forged plain-JSON verdict', () => {
    // RFC-0042 Phase 3 (AISDLC-383.6) behavioral change:
    // Pre-cutover: hook exited 2 (blocked) on forged plain-JSON verdicts in v5 mode.
    // Post-cutover: v5 mode is audit-only — hook warns + proceeds to sign (exit 1 = re-push).
    // Default (v6): sub-attestation gate skipped entirely.
    //
    // This test uses AI_SDLC_SCHEMA_VERSION=v5 to verify that the v5 audit-only
    // path emits a warning but does NOT block the push.

    // Set up a git repo.
    const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-hook-int-'));
    try {
      const git = (args) =>
        execFileSync('git', args, {
          cwd: root,
          env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
          encoding: 'utf-8',
        });

      git(['init', '-q', '-b', 'main']);
      git(['config', 'user.email', 'test@test.com']);
      git(['config', 'user.name', 'test']);
      git(['config', 'commit.gpgsign', 'false']);
      writeFileSync(join(root, 'README.md'), 'baseline\n');
      git(['add', '.']);
      git(['commit', '-q', '-m', 'baseline']);
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

      // Set up active-task sentinel.
      writeFileSync(join(root, '.active-task'), 'AISDLC-380\n');

      // Write a FORGED plain-JSON verdict (no sub-attestations).
      mkdirSync(join(root, '.ai-sdlc', 'verdicts'), { recursive: true });
      const forgeryPath = join(root, '.ai-sdlc', 'verdicts', 'aisdlc-380.json');
      writeFileSync(
        forgeryPath,
        JSON.stringify([
          {
            agentId: 'code-reviewer',
            harness: 'claude-code',
            approved: true,
            findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
            summary: 'Forged approval',
          },
        ]),
      );

      // Set up trusted-reviewers.yaml with no reviewer entries (so verifier has something to check).
      mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
      writeFileSync(
        join(root, '.ai-sdlc', 'trusted-reviewers.yaml'),
        `reviewers:\n  - identity: 'op@example.com'\n    machine: 'laptop'\n    addedAt: '2026-05-20'\n    addedBy: 'test'\n    pubkey: |\n      -----BEGIN PUBLIC KEY-----\n      MCowBQYDK2VwAyEA7RfNqQjnRnt7dG0gjIWIkqyfvn+/aMycmbaEbq7lS7E=\n      -----END PUBLIC KEY-----\n`,
      );

      // Copy the verify script to the root so check-attestation-sign.sh finds it.
      mkdirSync(join(root, 'scripts'), { recursive: true });
      execFileSync('cp', [SCRIPT, join(root, 'scripts', 'verify-reviewer-sub-attestations.mjs')]);

      // Install a fake signer that writes the right .dsse.json (v5 mode).
      const attDir = join(root, '.ai-sdlc', 'attestations');
      mkdirSync(attDir, { recursive: true });
      const shimPath = join(root, 'fake-signer.sh');
      writeFileSync(
        shimPath,
        `#!/usr/bin/env bash
WT_ROOT=$(git rev-parse --show-toplevel)
HEAD=$(git rev-parse HEAD)
mkdir -p "$WT_ROOT/.ai-sdlc/attestations"
printf '{"_test":"stub"}' > "$WT_ROOT/.ai-sdlc/attestations/$HEAD.dsse.json"
exit 0`,
      );
      execFileSync('chmod', ['+x', shimPath]);

      const hookScript = join(__dirname, 'check-attestation-sign.sh');

      const hookResult = spawnSync('bash', [hookScript], {
        cwd: root,
        env: {
          ...process.env,
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          AI_SDLC_SKIP_ATTESTATION_SIGN: undefined,
          AI_SDLC_SIGN_ATTESTATION_CMD: `bash ${shimPath}`,
          // Force v5 mode to exercise the audit-only path.
          AI_SDLC_SCHEMA_VERSION: 'v5',
          // Explicitly unset stub verifier so the real verifier runs.
          AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD: '',
          AI_SDLC_TEST_MODE: '',
        },
        encoding: 'utf-8',
      });

      // RFC-0042 Phase 3: audit-only → hook warns but proceeds to sign (exit 1 = re-push needed).
      assert.equal(
        hookResult.status,
        1,
        `expected exit 1 (audit-only: warned + signed), got ${hookResult.status}: stderr=${hookResult.stderr}`,
      );
      // Must emit audit-only warning.
      assert.match(
        hookResult.stderr,
        /WARN.*sub-attestation verification failed.*audit-only|WARN.*push not blocked/i,
        `stderr must show audit-only warning: ${hookResult.stderr}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
