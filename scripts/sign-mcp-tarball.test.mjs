/**
 * Hermetic tests for sign-mcp-tarball.mjs and verify-mcp-tarball.mjs
 * (AISDLC-439).
 *
 * Run with: node --test scripts/sign-mcp-tarball.test.mjs
 *
 * Tests cover:
 *  - Round-trip: sign predicate → verify succeeds
 *  - Signature failure path: wrong key → verify rejects
 *  - SHA mismatch path: tampered tarball → verify rejects
 *  - Envelope-missing path: no envelope file → exit code 2
 *  - Pubkey-not-trusted path: signer key not in trusted-reviewers → rejects
 *  - parseTrustedReviewersYaml: well-formed and edge-case YAML input
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  TARBALL_PREDICATE_TYPE,
  buildTarballPredicate,
  sha512Hex,
  signTarballEnvelope,
} from './sign-mcp-tarball.mjs';

import {
  parseTrustedReviewersYaml,
  verifyDsseSignature,
  verifyTarballAttestation,
  loadTrustedReviewers,
  formatVerificationError,
} from './verify-mcp-tarball.mjs';

// ── Key generation helpers ────────────────────────────────────────────

/**
 * Generate a fresh ed25519 key pair for testing.
 * Returns { privateKeyPem, publicKeyPem }.
 */
function generateTestKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  return { privateKeyPem, publicKeyPem };
}

/**
 * Build a minimal trusted-reviewers.yaml snippet for a given public key.
 */
function makeTrustedReviewersYaml(identity, machine, publicKeyPem) {
  // Format matches the strict spec in .ai-sdlc/trusted-reviewers.yaml.
  const pemLines = publicKeyPem
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => `      ${l}`)
    .join('\n');
  return `reviewers:\n  - identity: '${identity}'\n    machine: '${machine}'\n    addedAt: '2026-01-01'\n    addedBy: 'test'\n    pubkey: |\n${pemLines}\n`;
}

// ── Fixture setup ─────────────────────────────────────────────────────

let tempDir;
let keyPair;
let altKeyPair;

before(() => {
  tempDir = join(tmpdir(), `aisdlc-439-test-${Date.now()}`);
  mkdirSync(join(tempDir, '.ai-sdlc', 'attestations'), { recursive: true });
  keyPair = generateTestKeyPair();
  altKeyPair = generateTestKeyPair(); // different key, not in trusted-reviewers
});

after(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ── Test: sha512Hex ───────────────────────────────────────────────────

describe('sha512Hex', () => {
  it('produces a 128-char lowercase hex string', () => {
    const result = sha512Hex(Buffer.from('hello world'));
    assert.strictEqual(result.length, 128);
    assert.match(result, /^[0-9a-f]+$/);
  });

  it('produces different hashes for different inputs', () => {
    const h1 = sha512Hex(Buffer.from('foo'));
    const h2 = sha512Hex(Buffer.from('bar'));
    assert.notStrictEqual(h1, h2);
  });

  it('is deterministic', () => {
    const buf = Buffer.from('deterministic test');
    assert.strictEqual(sha512Hex(buf), sha512Hex(buf));
  });
});

// ── Test: buildTarballPredicate ───────────────────────────────────────

describe('buildTarballPredicate', () => {
  it('includes correct _type, predicateType, and predicate fields', () => {
    const pred = buildTarballPredicate({
      packageName: '@ai-sdlc/plugin-mcp-server',
      version: '1.2.3',
      sha512: 'abc123',
      tarballUrl:
        'https://registry.npmjs.org/@ai-sdlc/plugin-mcp-server/-/plugin-mcp-server-1.2.3.tgz',
      registry: 'https://registry.npmjs.org',
      signerIdentity: 'test@example.com',
      machine: 'test-machine',
    });

    assert.strictEqual(pred._type, 'https://in-toto.io/Statement/v1');
    assert.strictEqual(pred.predicateType, TARBALL_PREDICATE_TYPE);
    assert.strictEqual(pred.predicate.schemaVersion, 'v1');
    assert.strictEqual(pred.predicate.packageName, '@ai-sdlc/plugin-mcp-server');
    assert.strictEqual(pred.predicate.version, '1.2.3');
    assert.strictEqual(pred.predicate.sha512, 'abc123');
    assert.strictEqual(pred.subject[0].name, '@ai-sdlc/plugin-mcp-server@1.2.3');
    assert.strictEqual(pred.subject[0].digest.sha512, 'abc123');
  });

  it('includes signedAt timestamp', () => {
    const pred = buildTarballPredicate({
      packageName: '@test/pkg',
      version: '0.0.1',
      sha512: 'deadbeef',
      tarballUrl: 'https://example.com/pkg.tgz',
      registry: 'https://example.com',
      signerIdentity: 'ci@ci',
      machine: 'ci-runner',
    });
    assert.ok(pred.predicate.signedAt);
    assert.doesNotThrow(() => new Date(pred.predicate.signedAt));
  });
});

// ── Test: signTarballEnvelope + verifyDsseSignature round-trip ────────

describe('sign + verify round-trip', () => {
  it('verifies successfully with the correct public key', () => {
    const tarballBuf = Buffer.from('fake tarball content for test');
    const sha512 = sha512Hex(tarballBuf);
    const predicate = buildTarballPredicate({
      packageName: '@ai-sdlc/plugin-mcp-server',
      version: '0.9.2',
      sha512,
      tarballUrl: 'https://registry.npmjs.org/...',
      registry: 'https://registry.npmjs.org',
      signerIdentity: 'test@example.com',
      machine: 'test-machine',
    });

    const envelope = signTarballEnvelope({
      predicate,
      privateKeyPem: keyPair.privateKeyPem,
      keyid: 'test@example.com:test-machine',
    });

    assert.strictEqual(envelope.payloadType, TARBALL_PREDICATE_TYPE);
    assert.ok(envelope.payload);
    assert.ok(envelope.signatures.length > 0);

    // Verify with correct public key.
    const pemWithHeaders = keyPair.publicKeyPem;
    const valid = verifyDsseSignature(envelope, pemWithHeaders);
    assert.strictEqual(valid, true);
  });

  it('rejects with a different (wrong) public key', () => {
    const tarballBuf = Buffer.from('fake tarball');
    const sha512 = sha512Hex(tarballBuf);
    const predicate = buildTarballPredicate({
      packageName: '@ai-sdlc/plugin-mcp-server',
      version: '0.9.2',
      sha512,
      tarballUrl: 'https://registry.npmjs.org/...',
      registry: 'https://registry.npmjs.org',
      signerIdentity: 'test@example.com',
      machine: 'test-machine',
    });
    const envelope = signTarballEnvelope({
      predicate,
      privateKeyPem: keyPair.privateKeyPem,
      keyid: 'test@example.com:test-machine',
    });

    // Use a different key that was not used to sign.
    const valid = verifyDsseSignature(envelope, altKeyPair.publicKeyPem);
    assert.strictEqual(valid, false);
  });

  it('rejects with a tampered payload', () => {
    const tarballBuf = Buffer.from('fake tarball');
    const sha512 = sha512Hex(tarballBuf);
    const predicate = buildTarballPredicate({
      packageName: '@ai-sdlc/plugin-mcp-server',
      version: '0.9.2',
      sha512,
      tarballUrl: 'https://registry.npmjs.org/...',
      registry: 'https://registry.npmjs.org',
      signerIdentity: 'test@example.com',
      machine: 'test-machine',
    });
    const envelope = signTarballEnvelope({
      predicate,
      privateKeyPem: keyPair.privateKeyPem,
      keyid: 'test@example.com:test-machine',
    });

    // Tamper with payload.
    const tamperedEnvelope = {
      ...envelope,
      payload: Buffer.from('{"tampered":true}').toString('base64'),
    };
    const valid = verifyDsseSignature(tamperedEnvelope, keyPair.publicKeyPem);
    assert.strictEqual(valid, false);
  });
});

// ── Test: parseTrustedReviewersYaml ──────────────────────────────────

describe('parseTrustedReviewersYaml', () => {
  it('parses a well-formed entry', () => {
    const yaml = `reviewers:\n  - identity: 'alice@example.com'\n    machine: 'macbook'\n    addedAt: '2026-01-01'\n    addedBy: 'bob'\n    pubkey: |\n      -----BEGIN PUBLIC KEY-----\n      MCowBQYDK2VwAyEAXXXX\n      -----END PUBLIC KEY-----\n`;
    const entries = parseTrustedReviewersYaml(yaml);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].identity, 'alice@example.com');
    assert.ok(entries[0].pubkey.includes('PUBLIC KEY'));
  });

  it('parses multiple entries', () => {
    const yaml =
      `reviewers:\n` +
      `  - identity: 'alice@example.com'\n    machine: 'mac'\n    pubkey: |\n      -----BEGIN PUBLIC KEY-----\n      AAA=\n      -----END PUBLIC KEY-----\n` +
      `  - identity: 'bob@example.com'\n    machine: 'linux'\n    pubkey: |\n      -----BEGIN PUBLIC KEY-----\n      BBB=\n      -----END PUBLIC KEY-----\n`;
    const entries = parseTrustedReviewersYaml(yaml);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].identity, 'alice@example.com');
    assert.strictEqual(entries[1].identity, 'bob@example.com');
  });

  it('filters out entries without pubkey', () => {
    const yaml = `reviewers:\n  - identity: 'nopubkey@example.com'\n    machine: 'mac'\n`;
    const entries = parseTrustedReviewersYaml(yaml);
    assert.strictEqual(entries.length, 0);
  });

  it('returns empty array for empty input', () => {
    const entries = parseTrustedReviewersYaml('');
    assert.strictEqual(entries.length, 0);
  });
});

// ── Test: verifyTarballAttestation ────────────────────────────────────

describe('verifyTarballAttestation', () => {
  let envelopePath;
  let tarballBuf;
  let trustedReviewersPath;

  before(() => {
    tarballBuf = Buffer.from('fake mcp server tarball bytes for testing');
    const sha512 = sha512Hex(tarballBuf);
    const version = '0.9.99';

    // Write trusted-reviewers.yaml.
    trustedReviewersPath = join(tempDir, 'trusted-reviewers.yaml');
    writeFileSync(
      trustedReviewersPath,
      makeTrustedReviewersYaml('ci@ai-sdlc.io', 'ci-runner', keyPair.publicKeyPem),
      'utf-8',
    );

    // Write a valid signed envelope.
    const predicate = buildTarballPredicate({
      packageName: '@ai-sdlc/plugin-mcp-server',
      version,
      sha512,
      tarballUrl: 'https://registry.npmjs.org/...',
      registry: 'https://registry.npmjs.org',
      signerIdentity: 'ci@ai-sdlc.io',
      machine: 'ci-runner',
    });
    const envelope = signTarballEnvelope({
      predicate,
      privateKeyPem: keyPair.privateKeyPem,
      keyid: 'ci@ai-sdlc.io:ci-runner',
    });

    envelopePath = join(tempDir, '.ai-sdlc', 'attestations', `mcp-server-${version}.dsse.json`);
    writeFileSync(envelopePath, JSON.stringify(envelope, null, 2) + '\n', 'utf-8');
  });

  it('returns valid=true on correct envelope + tarball + key', () => {
    const trustedReviewers = loadTrustedReviewers(trustedReviewersPath);
    const result = verifyTarballAttestation({ envelopePath, tarballBuf, trustedReviewers });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.reason, 'ok');
    assert.strictEqual(result.signerIdentity, 'ci@ai-sdlc.io');
  });

  it('returns valid=false with reason=envelope-missing when file absent', () => {
    const trustedReviewers = loadTrustedReviewers(trustedReviewersPath);
    const result = verifyTarballAttestation({
      envelopePath: join(tempDir, 'nonexistent.dsse.json'),
      tarballBuf,
      trustedReviewers,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'envelope-missing');
  });

  it('returns valid=false with reason=sha-mismatch when tarball is tampered', () => {
    const trustedReviewers = loadTrustedReviewers(trustedReviewersPath);
    const tamperedBuf = Buffer.from('TAMPERED CONTENT — not the real tarball');
    const result = verifyTarballAttestation({
      envelopePath,
      tarballBuf: tamperedBuf,
      trustedReviewers,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'sha-mismatch');
    assert.ok(result.expected);
    assert.ok(result.actual);
    assert.notStrictEqual(result.expected, result.actual);
  });

  it('returns valid=false with reason=signature-invalid when key not trusted', () => {
    // Build a trusted-reviewers.yaml with the ALT key (not the one that signed the envelope).
    const altTrustedPath = join(tempDir, 'trusted-reviewers-alt.yaml');
    writeFileSync(
      altTrustedPath,
      makeTrustedReviewersYaml('other@ai-sdlc.io', 'other-machine', altKeyPair.publicKeyPem),
      'utf-8',
    );
    const trustedReviewers = loadTrustedReviewers(altTrustedPath);
    const result = verifyTarballAttestation({ envelopePath, tarballBuf, trustedReviewers });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'signature-invalid');
  });

  it('returns valid=false with reason=envelope-parse-error for corrupt JSON', () => {
    const corruptPath = join(tempDir, '.ai-sdlc', 'attestations', 'mcp-server-corrupt.dsse.json');
    writeFileSync(corruptPath, 'NOT VALID JSON{{{', 'utf-8');
    const trustedReviewers = loadTrustedReviewers(trustedReviewersPath);
    const result = verifyTarballAttestation({
      envelopePath: corruptPath,
      tarballBuf,
      trustedReviewers,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'envelope-parse-error');
  });

  it('returns valid=false with reason=predicate-type-mismatch for wrong predicateType', () => {
    const wrongTypePath = join(
      tempDir,
      '.ai-sdlc',
      'attestations',
      'mcp-server-wrongtype.dsse.json',
    );
    const wrongEnvelope = {
      payload: Buffer.from('{}').toString('base64'),
      payloadType: 'https://example.com/wrong-type/v1',
      signatures: [],
    };
    writeFileSync(wrongTypePath, JSON.stringify(wrongEnvelope, null, 2) + '\n', 'utf-8');
    const trustedReviewers = loadTrustedReviewers(trustedReviewersPath);
    const result = verifyTarballAttestation({
      envelopePath: wrongTypePath,
      tarballBuf,
      trustedReviewers,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'predicate-type-mismatch');
  });
});

// ── Test: formatVerificationError ────────────────────────────────────

describe('formatVerificationError', () => {
  const base = {
    version: '0.9.2',
    envelopePath: '/tmp/mcp-server-0.9.2.dsse.json',
    trustedReviewersPath: '/tmp/trusted-reviewers.yaml',
  };

  it('includes version in all error messages', () => {
    for (const reason of [
      'envelope-missing',
      'envelope-parse-error',
      'sha-mismatch',
      'signature-invalid',
    ]) {
      const msg = formatVerificationError({ ...base, reason, expected: 'exp', actual: 'act' });
      assert.ok(msg.includes('0.9.2'), `Expected version in message for reason=${reason}`);
    }
  });

  it('mentions recovery path in sha-mismatch message', () => {
    const msg = formatVerificationError({
      ...base,
      reason: 'sha-mismatch',
      expected: 'aaa',
      actual: 'bbb',
    });
    assert.ok(msg.includes('Recovery'));
    assert.ok(msg.includes('npm install'));
  });

  it('mentions trusted-reviewers in signature-invalid message', () => {
    const msg = formatVerificationError({ ...base, reason: 'signature-invalid' });
    assert.ok(msg.includes('trusted-reviewers.yaml'));
  });

  it('mentions git pull in envelope-missing message', () => {
    const msg = formatVerificationError({ ...base, reason: 'envelope-missing' });
    assert.ok(msg.includes('git'));
  });
});
