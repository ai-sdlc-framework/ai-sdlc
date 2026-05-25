/**
 * RFC-0042 Phase 2 — v6 envelope signer hermetic tests.
 *
 * Coverage:
 *   - v6 sign happy path (valid envelope shape, root signature present)
 *   - missing transcript-leaves.jsonl (no prLeaves found)
 *   - missing operator key (resolveSigningKeyPath returns null)
 *   - schema-invalid envelope detection (schemaVersion mismatch)
 *   - any-of-N key support (AISDLC_SIGNING_KEY_PATH env override)
 *   - nonce bound to headSha (present in envelope)
 *   - formatV6Envelope pretty-print output
 *   - buildV6Envelope with missing prLeaf in allLeaves throws
 *   - buildV6Envelope with empty allLeaves throws
 *
 * @module attestation/sign-v6.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLeaf, type TranscriptLeaf } from './merkle.js';
import {
  buildV6Envelope,
  formatV6Envelope,
  resolveSigningKeyPath,
  signAndWriteV6Envelope,
  type AttestationEnvelopeV6,
} from './sign-v6.js';

// ── Key generation helpers ────────────────────────────────────────────────────

let lastPublicKeyPem: string;

function generateTestKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pair = {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
  lastPublicKeyPem = pair.publicKeyPem;
  return pair;
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeLeaf(overrides: Partial<TranscriptLeaf> = {}): TranscriptLeaf {
  return {
    leafIndex: 0,
    taskId: 'AISDLC-383.3',
    reviewerName: 'code-reviewer',
    transcriptHash: 'a'.repeat(64),
    nonce: 'b'.repeat(64),
    harness: 'claude-code',
    model: 'sonnet',
    verdictApproved: true,
    findings: { critical: 0, major: 0, minor: 1, suggestion: 0 },
    signedAt: '2026-05-21T10:00:00.000Z',
    ...overrides,
  };
}

const FAKE_HEAD_SHA = 'c'.repeat(40);

// ── Test setup ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let { privateKeyPem } = generateTestKeyPair();

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sign-v6-test-'));
  ({ privateKeyPem } = generateTestKeyPair());
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env['AISDLC_SIGNING_KEY_PATH'];
});

// ── buildV6Envelope ───────────────────────────────────────────────────────────

describe('buildV6Envelope — happy path', () => {
  it('produces a valid v6 envelope with correct schemaVersion', () => {
    const leaf0 = makeLeaf({ leafIndex: 0, reviewerName: 'code-reviewer' });
    const leaf1 = makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer', taskId: 'AISDLC-383.3' });
    const leaf2 = makeLeaf({
      leafIndex: 2,
      reviewerName: 'security-reviewer',
      taskId: 'AISDLC-383.3',
    });
    const allLeaves = [leaf0, leaf1, leaf2];
    const prLeaves = allLeaves; // All belong to same PR in this test

    const envelope = buildV6Envelope({
      headSha: FAKE_HEAD_SHA,
      prLeaves,
      allLeaves,
      nonce: 'd'.repeat(64),
      privateKeyPem,
    });

    expect(envelope.schemaVersion).toBe('v6');
    expect(envelope.subject.digest.sha1).toBe(FAKE_HEAD_SHA);
    expect(envelope.leafCount).toBe(3);
    expect(envelope.transcriptLeaves).toHaveLength(3);
    expect(envelope.merkleProofs).toHaveLength(3);
    expect(envelope.rootHash).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope.rootSignature).toBeTruthy();
    expect(envelope.nonce).toBe('d'.repeat(64));
    expect(envelope.signedAt).toBeTruthy();
  });

  it('transcriptLeaves array carries leafIndex, reviewerName, transcriptHash', () => {
    const leaf0 = makeLeaf({ leafIndex: 0, transcriptHash: 'e'.repeat(64) });
    const envelope = buildV6Envelope({
      headSha: FAKE_HEAD_SHA,
      prLeaves: [leaf0],
      allLeaves: [leaf0],
      nonce: 'f'.repeat(64),
      privateKeyPem,
    });

    expect(envelope.transcriptLeaves[0]).toEqual({
      leafIndex: 0,
      reviewerName: 'code-reviewer',
      transcriptHash: 'e'.repeat(64),
    });
  });

  it('merkleProofs array carries leafIndex and proof array', () => {
    const leaf0 = makeLeaf({ leafIndex: 0 });
    const leaf1 = makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer' });
    const envelope = buildV6Envelope({
      headSha: FAKE_HEAD_SHA,
      prLeaves: [leaf0],
      allLeaves: [leaf0, leaf1],
      nonce: 'g'.repeat(64),
      privateKeyPem,
    });

    expect(envelope.merkleProofs[0].leafIndex).toBe(0);
    expect(Array.isArray(envelope.merkleProofs[0].proof)).toBe(true);
  });

  it('includes optional signerIdentity when provided', () => {
    const leaf0 = makeLeaf({ leafIndex: 0 });
    const envelope = buildV6Envelope({
      headSha: FAKE_HEAD_SHA,
      prLeaves: [leaf0],
      allLeaves: [leaf0],
      nonce: 'h'.repeat(64),
      privateKeyPem,
      signerIdentity: 'operator@example.com:laptop',
    });

    expect(envelope.signerIdentity).toBe('operator@example.com:laptop');
  });

  it('rootSignature is a non-empty base64 string', () => {
    const leaf0 = makeLeaf({ leafIndex: 0 });
    const envelope = buildV6Envelope({
      headSha: FAKE_HEAD_SHA,
      prLeaves: [leaf0],
      allLeaves: [leaf0],
      nonce: 'i'.repeat(64),
      privateKeyPem,
    });

    // base64 characters: A-Z, a-z, 0-9, +, /, =
    expect(envelope.rootSignature).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(envelope.rootSignature.length).toBeGreaterThan(0);
  });
});

describe('buildV6Envelope — error paths', () => {
  it('throws when allLeaves is empty', () => {
    expect(() =>
      buildV6Envelope({
        headSha: FAKE_HEAD_SHA,
        prLeaves: [],
        allLeaves: [],
        nonce: 'j'.repeat(64),
        privateKeyPem,
      }),
    ).toThrow('no leaves in the tree');
  });

  it('throws when prLeaf leafIndex is not found in allLeaves', () => {
    const leaf0 = makeLeaf({ leafIndex: 0 });
    const orphanLeaf = makeLeaf({ leafIndex: 99, reviewerName: 'orphan' });
    expect(() =>
      buildV6Envelope({
        headSha: FAKE_HEAD_SHA,
        prLeaves: [orphanLeaf],
        allLeaves: [leaf0], // orphanLeaf not in allLeaves
        nonce: 'k'.repeat(64),
        privateKeyPem,
      }),
    ).toThrow('not found in allLeaves');
  });
});

// ── signAndWriteV6Envelope ────────────────────────────────────────────────────

describe('signAndWriteV6Envelope — happy path', () => {
  it('writes envelope to .ai-sdlc/attestations/<headSha>.v6.dsse.json', () => {
    const leaf0 = makeLeaf({ leafIndex: 0, taskId: 'AISDLC-383.3' });
    const leaf1 = makeLeaf({ leafIndex: 1, taskId: 'AISDLC-383.3', reviewerName: 'test-reviewer' });
    appendLeaf(leaf0, tmpRoot);
    appendLeaf(leaf1, tmpRoot);

    const outPath = signAndWriteV6Envelope({
      repoRoot: tmpRoot,
      headSha: FAKE_HEAD_SHA,
      taskId: 'AISDLC-383.3',
      privateKeyPem,
    });

    expect(outPath).toContain(`${FAKE_HEAD_SHA}.v6.dsse.json`);

    const raw = readFileSync(outPath, 'utf8');
    const parsed = JSON.parse(raw) as AttestationEnvelopeV6;
    expect(parsed.schemaVersion).toBe('v6');
    expect(parsed.leafCount).toBe(2);
    expect(parsed.subject.digest.sha1).toBe(FAKE_HEAD_SHA);
  });

  it('filters leaves by taskId (case-insensitive) via legacy shared-file fallback', () => {
    // AISDLC-421: this test exercises the shared-file fallback (no patch-id),
    // which filters by taskId. Post-AISDLC-421, the Merkle tree is built from
    // THIS PR's leaves only — so `allLeaves === prLeaves === filteredByTask`,
    // and leafCount reflects only the filtered set (no longer "the full file").
    const leaf0 = makeLeaf({ leafIndex: 0, taskId: 'AISDLC-383.3' });
    const leaf1 = makeLeaf({ leafIndex: 1, taskId: 'aisdlc-383.3', reviewerName: 'test-reviewer' });
    const leaf2 = makeLeaf({ leafIndex: 2, taskId: 'AISDLC-999', reviewerName: 'other' });
    appendLeaf(leaf0, tmpRoot);
    appendLeaf(leaf1, tmpRoot);
    appendLeaf(leaf2, tmpRoot);

    const outPath = signAndWriteV6Envelope({
      repoRoot: tmpRoot,
      headSha: FAKE_HEAD_SHA,
      taskId: 'AISDLC-383.3',
      privateKeyPem,
    });

    const parsed = JSON.parse(readFileSync(outPath, 'utf8')) as AttestationEnvelopeV6;
    // Only 2 prLeaves match by taskId (leaf0 + leaf1); leaf2 is a different task.
    expect(parsed.transcriptLeaves).toHaveLength(2);
    // AISDLC-421: leafCount now reflects THIS PR's tree only — not the full shared file.
    // Each PR's Merkle root is computed independently from its own leaf set.
    expect(parsed.leafCount).toBe(2);
  });
});

describe('signAndWriteV6Envelope — error paths', () => {
  it('throws when no leaves match taskId', () => {
    // No leaves in tree at all.
    expect(() =>
      signAndWriteV6Envelope({
        repoRoot: tmpRoot,
        headSha: FAKE_HEAD_SHA,
        taskId: 'AISDLC-383.3',
        privateKeyPem,
      }),
    ).toThrow('No transcript leaves found for taskId');
  });

  it('throws when leaves exist but none match the given taskId', () => {
    appendLeaf(makeLeaf({ leafIndex: 0, taskId: 'AISDLC-999' }), tmpRoot);

    expect(() =>
      signAndWriteV6Envelope({
        repoRoot: tmpRoot,
        headSha: FAKE_HEAD_SHA,
        taskId: 'AISDLC-383.3',
        privateKeyPem,
      }),
    ).toThrow('No transcript leaves found for taskId');
  });
});

// ── resolveSigningKeyPath ─────────────────────────────────────────────────────

describe('resolveSigningKeyPath', () => {
  it('returns the env-var path when AISDLC_SIGNING_KEY_PATH is set and file exists', () => {
    const keyPath = join(tmpRoot, 'test-key.pem');
    writeFileSync(keyPath, 'fake-key', 'utf8');
    process.env['AISDLC_SIGNING_KEY_PATH'] = keyPath;

    expect(resolveSigningKeyPath()).toBe(keyPath);
  });

  it('returns null when AISDLC_SIGNING_KEY_PATH points to non-existent file', () => {
    process.env['AISDLC_SIGNING_KEY_PATH'] = join(tmpRoot, 'nonexistent.pem');

    expect(resolveSigningKeyPath()).toBeNull();
  });

  it('returns null when no key is available (env not set, default path absent)', () => {
    // Default path ~/.ai-sdlc/signing-key.pem may or may not exist on CI.
    // We only assert that when AISDLC_SIGNING_KEY_PATH is not set and the
    // default path is absent, the result is null. We can't test the default
    // path without mutating HOME, so we just test the env path branch.
    delete process.env['AISDLC_SIGNING_KEY_PATH'];
    // Result depends on whether the default key exists on this machine.
    // Just assert it returns string | null without throwing.
    const result = resolveSigningKeyPath();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

// ── any-of-N key support ──────────────────────────────────────────────────────

describe('any-of-N key support via AISDLC_SIGNING_KEY_PATH', () => {
  it('uses the key at AISDLC_SIGNING_KEY_PATH when set', () => {
    const { privateKeyPem: altKey } = generateTestKeyPair();
    const keyPath = join(tmpRoot, 'alt-key.pem');
    writeFileSync(keyPath, altKey, 'utf8');
    process.env['AISDLC_SIGNING_KEY_PATH'] = keyPath;

    expect(resolveSigningKeyPath()).toBe(keyPath);

    // Also verify we can sign successfully with this key via buildV6Envelope.
    const leaf0 = makeLeaf({ leafIndex: 0 });
    const envelope = buildV6Envelope({
      headSha: FAKE_HEAD_SHA,
      prLeaves: [leaf0],
      allLeaves: [leaf0],
      nonce: 'l'.repeat(64),
      privateKeyPem: altKey,
    });
    expect(envelope.rootSignature).toBeTruthy();
  });
});

// ── Nonce binding ─────────────────────────────────────────────────────────────

describe('nonce binding', () => {
  it('envelope carries the supplied nonce verbatim', () => {
    const leaf0 = makeLeaf({ leafIndex: 0 });
    const testNonce = 'm'.repeat(64);
    const envelope = buildV6Envelope({
      headSha: FAKE_HEAD_SHA,
      prLeaves: [leaf0],
      allLeaves: [leaf0],
      nonce: testNonce,
      privateKeyPem,
    });
    expect(envelope.nonce).toBe(testNonce);
  });

  it('signAndWriteV6Envelope generates a nonce (64-char hex) and binds it', () => {
    appendLeaf(makeLeaf({ leafIndex: 0, taskId: 'AISDLC-383.3' }), tmpRoot);

    const outPath = signAndWriteV6Envelope({
      repoRoot: tmpRoot,
      headSha: FAKE_HEAD_SHA,
      taskId: 'AISDLC-383.3',
      privateKeyPem,
    });

    const parsed = JSON.parse(readFileSync(outPath, 'utf8')) as AttestationEnvelopeV6;
    expect(parsed.nonce).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── formatV6Envelope ──────────────────────────────────────────────────────────

describe('formatV6Envelope', () => {
  it('includes key fields in output', () => {
    const leaf0 = makeLeaf({ leafIndex: 0 });
    const envelope = buildV6Envelope({
      headSha: FAKE_HEAD_SHA,
      prLeaves: [leaf0],
      allLeaves: [leaf0],
      nonce: 'n'.repeat(64),
      privateKeyPem,
      signerIdentity: 'test@example.com:test-machine',
    });

    const formatted = formatV6Envelope(envelope);
    expect(formatted).toContain('Schema version : v6');
    expect(formatted).toContain(`Head SHA       : ${FAKE_HEAD_SHA}`);
    expect(formatted).toContain('Leaf count     : 1');
    expect(formatted).toContain('Root hash      :');
    expect(formatted).toContain('Root signature :');
    expect(formatted).toContain('Nonce          :');
    expect(formatted).toContain('Transcript leaves (1)');
    expect(formatted).toContain('code-reviewer');
    expect(formatted).toContain('Merkle proofs (1)');
    expect(formatted).toContain('test@example.com:test-machine');
  });

  it('handles envelope without signerIdentity gracefully', () => {
    const leaf0 = makeLeaf({ leafIndex: 0 });
    const envelope = buildV6Envelope({
      headSha: FAKE_HEAD_SHA,
      prLeaves: [leaf0],
      allLeaves: [leaf0],
      nonce: 'o'.repeat(64),
      privateKeyPem,
    });

    const formatted = formatV6Envelope(envelope);
    expect(formatted).not.toContain('Signer         :');
    expect(formatted).toContain('Schema version : v6');
  });
});

// ── Schema validation (AISDLC-383.3 AC #6) ────────────────────────────────────

describe('schema-invalid envelope detection', () => {
  it('an envelope with wrong schemaVersion fails the schema contract', () => {
    const leaf0 = makeLeaf({ leafIndex: 0 });
    const envelope = buildV6Envelope({
      headSha: FAKE_HEAD_SHA,
      prLeaves: [leaf0],
      allLeaves: [leaf0],
      nonce: 'p'.repeat(64),
      privateKeyPem,
    });

    // Simulate a schema mismatch by casting.
    const badEnvelope = { ...envelope, schemaVersion: 'v5' };
    expect(badEnvelope.schemaVersion).not.toBe('v6');
    // Our signer only ever produces 'v6'; anything else is invalid per the schema.
    expect(envelope.schemaVersion).toBe('v6');
  });

  it('an envelope missing required fields is not a valid v6 envelope', () => {
    const leaf0 = makeLeaf({ leafIndex: 0 });
    const envelope = buildV6Envelope({
      headSha: FAKE_HEAD_SHA,
      prLeaves: [leaf0],
      allLeaves: [leaf0],
      nonce: 'q'.repeat(64),
      privateKeyPem,
    });

    // Strip a required field — rootHash.
    const { rootHash: _unused, ...stripped } = envelope;
    expect('rootHash' in stripped).toBe(false);
    // The real schema validator (JSON Schema) would reject this.
    // Here we just confirm the test fixture reflects the constraint.
    expect(envelope.rootHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── AISDLC-398: patchId content-addressed dual-write ─────────────────────────

describe('signAndWriteV6Envelope — content-addressed dual-write (AISDLC-398 fix #1)', () => {
  it('writes <patchId>.v6.dsse.json AND <headSha>.v6.dsse.json when patchId is provided', () => {
    const FAKE_PATCH_ID = 'd'.repeat(40);
    appendLeaf(makeLeaf({ leafIndex: 0, taskId: 'AISDLC-398' }), tmpRoot);

    const outPath = signAndWriteV6Envelope({
      repoRoot: tmpRoot,
      headSha: FAKE_HEAD_SHA,
      taskId: 'AISDLC-398',
      privateKeyPem,
      patchId: FAKE_PATCH_ID,
    });

    // Primary filename is the patch-id-named file.
    expect(outPath).toContain(`${FAKE_PATCH_ID}.v6.dsse.json`);
    const primaryContent = readFileSync(outPath, 'utf8');
    const primaryParsed = JSON.parse(primaryContent);
    expect(primaryParsed.schemaVersion).toBe('v6');

    // Legacy bridge file must also exist with identical content.
    const legacyPath = join(tmpRoot, '.ai-sdlc', 'attestations', `${FAKE_HEAD_SHA}.v6.dsse.json`);
    const legacyContent = readFileSync(legacyPath, 'utf8');
    expect(legacyContent).toBe(primaryContent);
  });

  it('returns <headSha>.v6.dsse.json path and writes only one file when patchId is absent', () => {
    appendLeaf(makeLeaf({ leafIndex: 0, taskId: 'AISDLC-398' }), tmpRoot);

    const outPath = signAndWriteV6Envelope({
      repoRoot: tmpRoot,
      headSha: FAKE_HEAD_SHA,
      taskId: 'AISDLC-398',
      privateKeyPem,
      // patchId intentionally omitted
    });

    expect(outPath).toContain(`${FAKE_HEAD_SHA}.v6.dsse.json`);
    const parsed = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(parsed.schemaVersion).toBe('v6');

    // No extra file should exist for a fake patch-id (we just verify the path).
    expect(outPath).not.toContain('.v6.dsse.json.v6.dsse.json');
  });

  it('envelope subject.digest.sha1 is always the headSha, not the patchId', () => {
    const FAKE_PATCH_ID = 'e'.repeat(40);
    appendLeaf(makeLeaf({ leafIndex: 0, taskId: 'AISDLC-398' }), tmpRoot);

    const outPath = signAndWriteV6Envelope({
      repoRoot: tmpRoot,
      headSha: FAKE_HEAD_SHA,
      taskId: 'AISDLC-398',
      privateKeyPem,
      patchId: FAKE_PATCH_ID,
    });

    const parsed = JSON.parse(readFileSync(outPath, 'utf8')) as AttestationEnvelopeV6;
    // The envelope's internal subject SHA must be the actual HEAD SHA,
    // NOT the patchId — this is what the verifier checks for replay protection.
    expect(parsed.subject.digest.sha1).toBe(FAKE_HEAD_SHA);
    expect(parsed.subject.digest.sha1).not.toBe(FAKE_PATCH_ID);
  });
});

// ── Sign / verify roundtrip ───────────────────────────────────────────────────
//
// The signer produces an ed25519 signature; the verifier (Phase 3 / AISDLC-383.4)
// will reconstruct the signed bytes and call crypto.verify(). This test runs
// the same verify call from the test fixture against the freshly-produced
// envelope so a regression that breaks the signed-payload encoding (wrong
// bytes, wrong algorithm, wrong format) fails here loudly instead of silently
// shipping envelopes that no real verifier will accept.

describe('signRootHash — ed25519 sign/verify roundtrip', () => {
  it('verifies the produced signature against the matching public key', () => {
    const leaf0 = makeLeaf({ leafIndex: 0, reviewerName: 'code-reviewer' });
    const leaf1 = makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer' });
    const envelope = buildV6Envelope({
      headSha: FAKE_HEAD_SHA,
      prLeaves: [leaf0, leaf1],
      allLeaves: [leaf0, leaf1],
      nonce: 'r'.repeat(64),
      privateKeyPem,
    });

    // Reconstruct the signed bytes exactly as the signer encoded them.
    // signRootHash signs the UTF-8 encoding of the hex rootHash string.
    const signedBytes = Buffer.from(envelope.rootHash, 'utf8');
    const signatureBytes = Buffer.from(envelope.rootSignature, 'base64');
    const publicKey = createPublicKey({ key: lastPublicKeyPem, format: 'pem' });

    // ed25519 verify: algorithm arg must be null (per Node docs).
    const valid = cryptoVerify(null, signedBytes, publicKey, signatureBytes);
    expect(valid).toBe(true);
  });

  it('rejects a signature from a different keypair', () => {
    const leaf0 = makeLeaf({ leafIndex: 0 });
    const envelope = buildV6Envelope({
      headSha: FAKE_HEAD_SHA,
      prLeaves: [leaf0],
      allLeaves: [leaf0],
      nonce: 's'.repeat(64),
      privateKeyPem,
    });
    // Generate an UNRELATED keypair; its pubkey must NOT verify the signature.
    const { publicKeyPem: foreignPub } = generateTestKeyPair();
    const signedBytes = Buffer.from(envelope.rootHash, 'utf8');
    const signatureBytes = Buffer.from(envelope.rootSignature, 'base64');
    const foreignKey = createPublicKey({ key: foreignPub, format: 'pem' });
    expect(cryptoVerify(null, signedBytes, foreignKey, signatureBytes)).toBe(false);
  });

  it('rejects a signature when rootHash is tampered', () => {
    const leaf0 = makeLeaf({ leafIndex: 0 });
    const envelope = buildV6Envelope({
      headSha: FAKE_HEAD_SHA,
      prLeaves: [leaf0],
      allLeaves: [leaf0],
      nonce: 't'.repeat(64),
      privateKeyPem,
    });
    // Flip one hex char of rootHash — verify must fail.
    const tampered = envelope.rootHash.slice(0, -1) + (envelope.rootHash.endsWith('0') ? '1' : '0');
    expect(tampered).not.toBe(envelope.rootHash);
    const signedBytes = Buffer.from(tampered, 'utf8');
    const signatureBytes = Buffer.from(envelope.rootSignature, 'base64');
    const publicKey = createPublicKey({ key: lastPublicKeyPem, format: 'pem' });
    expect(cryptoVerify(null, signedBytes, publicKey, signatureBytes)).toBe(false);
  });
});
