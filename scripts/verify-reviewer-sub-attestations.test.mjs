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

function canonicalVerdictHash(verdict) {
  const sorted = Object.fromEntries(Object.entries(verdict).sort(([a], [b]) => a.localeCompare(b)));
  return sha256Hex(JSON.stringify(sorted));
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

  // ── check-attestation-sign.sh integration: sub-attestation verification ─

  it('AC#6 integration: check-attestation-sign.sh rejects forged plain-JSON verdict via verify sub-attestations step', () => {
    // This test verifies that the full hook chain (check-attestation-sign.sh)
    // refuses to sign when the verdict file is a dev-forged plain-JSON shape.
    // We use AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD to inject a real verifier call.

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

      // Set up trusted-reviewers.yaml with no reviewer entries.
      mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
      writeFileSync(
        join(root, '.ai-sdlc', 'trusted-reviewers.yaml'),
        `reviewers:\n  - identity: 'op@example.com'\n    machine: 'laptop'\n    addedAt: '2026-05-20'\n    addedBy: 'test'\n    pubkey: |\n      -----BEGIN PUBLIC KEY-----\n      MCowBQYDK2VwAyEA7RfNqQjnRnt7dG0gjIWIkqyfvn+/aMycmbaEbq7lS7E=\n      -----END PUBLIC KEY-----\n`,
      );

      // Copy the verify script to the root so check-attestation-sign.sh finds it.
      mkdirSync(join(root, 'scripts'), { recursive: true });
      execFileSync('cp', [SCRIPT, join(root, 'scripts', 'verify-reviewer-sub-attestations.mjs')]);

      const hookScript = join(__dirname, 'check-attestation-sign.sh');

      const hookResult = spawnSync('bash', [hookScript], {
        cwd: root,
        env: {
          ...process.env,
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          AI_SDLC_SKIP_ATTESTATION_SIGN: undefined,
          // Use a fake signer that would succeed but we expect to never reach it.
          AI_SDLC_SIGN_ATTESTATION_CMD: 'echo fake-signer-should-not-be-called',
        },
        encoding: 'utf-8',
      });

      // The hook must exit 2 (sub-attestation verification failure).
      assert.equal(
        hookResult.status,
        2,
        `expected exit 2 (refused to sign forged verdict), got ${hookResult.status}: stderr=${hookResult.stderr}`,
      );
      assert.match(
        hookResult.stderr,
        /sub-attestation verification failed|legacy plain-JSON|ERROR/i,
        `stderr must explain the refusal: ${hookResult.stderr}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
