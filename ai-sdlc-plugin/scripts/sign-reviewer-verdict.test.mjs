#!/usr/bin/env node
/**
 * CLI-level tests for `ai-sdlc-plugin/scripts/sign-reviewer-verdict.mjs`.
 *
 * Part of AISDLC-380 Bug #5 — the script had zero subprocess-level tests.
 *
 * Covers:
 *   - Argument validation (missing required args)
 *   - Valid signing path (key on disk, valid verdict JSON)
 *   - --key-path override gated by AI_SDLC_TEST_MODE=1
 *   - Missing key → informative error message
 *   - Malformed verdict JSON → error
 *   - Output to file vs stdout
 *   - Nested verdict JSON → canonical hash agreed between sign and verify
 *
 * Run with: node --test ai-sdlc-plugin/scripts/sign-reviewer-verdict.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'sign-reviewer-verdict.mjs');

function run(args, env = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

function generateKeyPem() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

describe('sign-reviewer-verdict.mjs (AISDLC-380 Bug #5)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-sign-rv-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Argument validation ────────────────────────────────────────────────────

  it('missing --reviewer-name → exits 1 with error', () => {
    const r = run(['--task-id', 'AISDLC-380', '--verdict-json', '{"approved":true,"findings":[]}']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(
      r.stderr,
      /reviewer-name.*required/i,
      `stderr must mention missing arg: ${r.stderr}`,
    );
  });

  it('missing --task-id → exits 1 with error', () => {
    const r = run([
      '--reviewer-name',
      'code-reviewer',
      '--verdict-json',
      '{"approved":true,"findings":[]}',
    ]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /task-id.*required/i, `stderr must mention missing arg: ${r.stderr}`);
  });

  it('missing --verdict-json → exits 1 with error', () => {
    const r = run(['--reviewer-name', 'code-reviewer', '--task-id', 'AISDLC-380']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(
      r.stderr,
      /verdict-json.*required/i,
      `stderr must mention missing arg: ${r.stderr}`,
    );
  });

  it('malformed verdict JSON → exits 1 with error', () => {
    const { privateKeyPem } = generateKeyPem();
    const keyPath = join(tmpDir, 'test.pem');
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });

    const r = run(
      [
        '--reviewer-name',
        'code-reviewer',
        '--task-id',
        'AISDLC-380',
        '--verdict-json',
        '{not-json}',
        '--key-path',
        keyPath,
      ],
      { AI_SDLC_TEST_MODE: '1' },
    );
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /not valid JSON/i, `stderr must mention JSON error: ${r.stderr}`);
  });

  it('verdict missing "approved" field → exits 1 with error', () => {
    const { privateKeyPem } = generateKeyPem();
    const keyPath = join(tmpDir, 'test.pem');
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });

    const r = run(
      [
        '--reviewer-name',
        'code-reviewer',
        '--task-id',
        'AISDLC-380',
        '--verdict-json',
        '{"findings":[]}',
        '--key-path',
        keyPath,
      ],
      { AI_SDLC_TEST_MODE: '1' },
    );
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /approved/i, `stderr must mention approved field: ${r.stderr}`);
  });

  it('verdict missing "findings" array → exits 1 with error', () => {
    const { privateKeyPem } = generateKeyPem();
    const keyPath = join(tmpDir, 'test.pem');
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });

    const r = run(
      [
        '--reviewer-name',
        'code-reviewer',
        '--task-id',
        'AISDLC-380',
        '--verdict-json',
        '{"approved":true}',
        '--key-path',
        keyPath,
      ],
      { AI_SDLC_TEST_MODE: '1' },
    );
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /findings/i, `stderr must mention findings: ${r.stderr}`);
  });

  // ── Missing key ───────────────────────────────────────────────────────────

  it('missing signing key → exits 1 with helpful message', () => {
    const missingKeyPath = join(tmpDir, 'nonexistent.pem');

    const r = run(
      [
        '--reviewer-name',
        'code-reviewer',
        '--task-id',
        'AISDLC-380',
        '--verdict-json',
        '{"approved":true,"findings":[]}',
        '--key-path',
        missingKeyPath,
      ],
      { AI_SDLC_TEST_MODE: '1' },
    );
    assert.equal(r.status, 1, `expected exit 1 (key missing), got ${r.status}: ${r.stderr}`);
    assert.match(
      r.stderr,
      /No signing key|init-reviewer-signing-key/i,
      `stderr must mention how to generate key: ${r.stderr}`,
    );
  });

  // ── --key-path gating ─────────────────────────────────────────────────────

  it('--key-path without AI_SDLC_TEST_MODE=1 → exits 1 with test-mode error', () => {
    const { privateKeyPem } = generateKeyPem();
    const keyPath = join(tmpDir, 'test.pem');
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });

    const r = run(
      [
        '--reviewer-name',
        'code-reviewer',
        '--task-id',
        'AISDLC-380',
        '--verdict-json',
        '{"approved":true,"findings":[]}',
        '--key-path',
        keyPath,
      ],
      // AI_SDLC_TEST_MODE is NOT set
      { AI_SDLC_TEST_MODE: '' },
    );
    assert.equal(r.status, 1, `expected exit 1 (test-mode guard), got ${r.status}: ${r.stderr}`);
    assert.match(
      r.stderr,
      /AI_SDLC_TEST_MODE=1|test mode/i,
      `stderr must explain test-mode requirement: ${r.stderr}`,
    );
  });

  it('--key-path with AI_SDLC_TEST_MODE=1 → accepted', () => {
    const { privateKeyPem } = generateKeyPem();
    const keyPath = join(tmpDir, 'test.pem');
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });

    const r = run(
      [
        '--reviewer-name',
        'code-reviewer',
        '--task-id',
        'AISDLC-380',
        '--verdict-json',
        '{"approved":true,"findings":[]}',
        '--key-path',
        keyPath,
      ],
      { AI_SDLC_TEST_MODE: '1' },
    );
    assert.equal(
      r.status,
      0,
      `expected exit 0 (key-path with test mode), got ${r.status}: ${r.stderr}`,
    );
  });

  // ── Valid signing path ────────────────────────────────────────────────────

  it('valid sign → writes sub-attestation to stdout', () => {
    const { privateKeyPem } = generateKeyPem();
    const keyPath = join(tmpDir, 'test.pem');
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });

    const verdict = { approved: true, findings: [], summary: 'LGTM' };
    const r = run(
      [
        '--reviewer-name',
        'code-reviewer',
        '--task-id',
        'AISDLC-380',
        '--verdict-json',
        JSON.stringify(verdict),
        '--key-path',
        keyPath,
      ],
      { AI_SDLC_TEST_MODE: '1' },
    );
    assert.equal(r.status, 0, `expected exit 0 (valid sign), got ${r.status}: ${r.stderr}`);

    let envelope;
    assert.doesNotThrow(() => {
      envelope = JSON.parse(r.stdout);
    }, `stdout must be valid JSON: ${r.stdout}`);

    assert.equal(envelope.reviewerName, 'code-reviewer', 'reviewerName must match');
    assert.equal(envelope.taskId, 'AISDLC-380', 'taskId must be normalized to uppercase');
    assert.ok(
      typeof envelope.signature === 'string' && envelope.signature.length > 0,
      'signature must be present',
    );
    assert.ok(
      typeof envelope.contentHash === 'string' && envelope.contentHash.length > 0,
      'contentHash must be present',
    );
    assert.ok(typeof envelope.signedAt === 'string', 'signedAt must be present');
    assert.ok(typeof envelope.keyid === 'string', 'keyid must be present');
    assert.deepEqual(envelope.verdict, verdict, 'verdict must be included');
  });

  it('valid sign → writes sub-attestation to --output file', () => {
    const { privateKeyPem } = generateKeyPem();
    const keyPath = join(tmpDir, 'test.pem');
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });

    const outputPath = join(tmpDir, 'sub-att', 'output.json');
    const verdict = { approved: true, findings: [], summary: 'LGTM' };

    const r = run(
      [
        '--reviewer-name',
        'code-reviewer',
        '--task-id',
        'AISDLC-380',
        '--verdict-json',
        JSON.stringify(verdict),
        '--key-path',
        keyPath,
        '--output',
        outputPath,
      ],
      { AI_SDLC_TEST_MODE: '1' },
    );
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    assert.equal(existsSync(outputPath), true, 'output file must be created');
    assert.match(r.stderr, /wrote sub-attestation/i, 'stderr must confirm write');

    const content = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.equal(content.reviewerName, 'code-reviewer');
    assert.ok(typeof content.signature === 'string' && content.signature.length > 0);
  });

  it('taskId is normalized to uppercase in the envelope', () => {
    const { privateKeyPem } = generateKeyPem();
    const keyPath = join(tmpDir, 'test.pem');
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });

    const r = run(
      [
        '--reviewer-name',
        'code-reviewer',
        '--task-id',
        'aisdlc-380', // lowercase input
        '--verdict-json',
        '{"approved":true,"findings":[]}',
        '--key-path',
        keyPath,
      ],
      { AI_SDLC_TEST_MODE: '1' },
    );
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    const envelope = JSON.parse(r.stdout);
    assert.equal(envelope.taskId, 'AISDLC-380', 'taskId must be uppercased');
  });

  // ── Nested verdict → canonical hash ──────────────────────────────────────

  it('nested verdict object → contentHash is stable (deep canonical JSON)', () => {
    const { privateKeyPem } = generateKeyPem();
    const keyPath = join(tmpDir, 'test.pem');
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });

    // Verdict with nested objects — keys out of alphabetical order.
    const verdict = {
      summary: 'Found issues',
      approved: false,
      findings: [{ severity: 'major', message: 'SQL injection', file: 'src/db.ts', line: 42 }],
      metadata: { reviewedAt: '2026-05-20', reviewer: 'code-reviewer' },
    };

    const r1 = run(
      [
        '--reviewer-name',
        'code-reviewer',
        '--task-id',
        'AISDLC-380',
        '--verdict-json',
        JSON.stringify(verdict),
        '--key-path',
        keyPath,
      ],
      { AI_SDLC_TEST_MODE: '1' },
    );
    assert.equal(r1.status, 0, `first sign failed: ${r1.stderr}`);
    const env1 = JSON.parse(r1.stdout);

    // Sign again with same verdict — hash must be identical.
    const r2 = run(
      [
        '--reviewer-name',
        'code-reviewer',
        '--task-id',
        'AISDLC-380',
        '--verdict-json',
        JSON.stringify(verdict),
        '--key-path',
        keyPath,
      ],
      { AI_SDLC_TEST_MODE: '1' },
    );
    assert.equal(r2.status, 0, `second sign failed: ${r2.stderr}`);
    const env2 = JSON.parse(r2.stdout);

    assert.equal(
      env1.contentHash,
      env2.contentHash,
      'contentHash must be identical for the same verdict (deterministic)',
    );
  });
});
