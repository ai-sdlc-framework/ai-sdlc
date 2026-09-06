/**
 * RFC-0046 Phase 1 (AISDLC-588) — hermetic tests for the `independenceTier`
 * verifier logic: weakest-link aggregation, dual-read fallback to legacy
 * `verdictClass`, and declared-vs-on-disk tamper rejection.
 *
 * Mirrors the sign → write → read-back → verify shape of
 * `sign-verify-parity.test.ts` (AISDLC-579) and the tamper-detection pattern
 * of the AISDLC-568 `verdictClass` precedent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLeafForPatchId, type TranscriptLeaf } from './merkle.js';
import { signAndWriteV6Envelope } from './sign-v6.js';
// verify-core.mjs is a plain, dependency-free ESM sibling — no .d.ts, so this
// import is untyped at the TS boundary (matches verify-core-loader.ts's
// documented pattern for consuming this file).
// @ts-expect-error -- plain ESM, no type declarations shipped
import { verifyV6Envelope } from '../../attestation-core/verify-core.mjs';

interface V6VerifyResult {
  status: string;
  reason: string;
  overallIndependenceTier?: string;
  independenceTiers?: { reviewerName: string; independenceTier: string }[];
}

function makeLeaf(overrides: Partial<TranscriptLeaf> = {}): TranscriptLeaf {
  return {
    leafIndex: 0,
    taskId: 'AISDLC-588',
    reviewerName: 'code-reviewer',
    transcriptHash: 'a'.repeat(64),
    nonce: 'b'.repeat(64),
    harness: 'claude-code',
    model: 'sonnet',
    verdictApproved: true,
    findings: { critical: 0, major: 0, minor: 1, suggestion: 0 },
    signedAt: '2026-09-06T10:00:00.000Z',
    ...overrides,
  };
}

const FAKE_HEAD_SHA = 'd'.repeat(40);

let tmpRoot: string;
let privateKeyPem: string;
let publicKeyPem: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'independence-tier-'));
  const kp = generateKeyPairSync('ed25519');
  privateKeyPem = kp.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  publicKeyPem = kp.publicKey.export({ format: 'pem', type: 'spki' }) as string;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function signAndVerify(patchId: string): V6VerifyResult {
  const outPath = signAndWriteV6Envelope({
    repoRoot: tmpRoot,
    headSha: FAKE_HEAD_SHA,
    taskId: 'AISDLC-588',
    privateKeyPem,
    patchId,
  });
  const envelope = JSON.parse(readFileSync(outPath, 'utf8'));
  return verifyEnvelope(envelope, patchId);
}

function verifyEnvelope(envelope: unknown, patchId: string): V6VerifyResult {
  return verifyV6Envelope({
    envelope,
    envelopeFileName: `${FAKE_HEAD_SHA}.v6.dsse.json`,
    headSha: FAKE_HEAD_SHA,
    trustedReviewers: [{ pubkey: publicKeyPem }],
    repoRoot: tmpRoot,
    patchIdHint: patchId,
  }) as V6VerifyResult;
}

describe('RFC-0046 Phase 1: independenceTier enum + weakest-link aggregation', () => {
  it('all leaves independenceTier=attested ⇒ overallIndependenceTier=attested', () => {
    const patchId = '1'.repeat(40);
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 0, reviewerName: 'code-reviewer', independenceTier: 'attested' }),
      patchId,
      tmpRoot,
    );
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer', independenceTier: 'attested' }),
      patchId,
      tmpRoot,
    );

    const result = signAndVerify(patchId);
    expect(result.status).toBe('valid');
    expect(result.overallIndependenceTier).toBe('attested');
  });

  it('any leaf independenceTier=none pulls the overall down to none (weakest link)', () => {
    const patchId = '2'.repeat(40);
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 0, reviewerName: 'code-reviewer', independenceTier: 'attested' }),
      patchId,
      tmpRoot,
    );
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer', independenceTier: 'none' }),
      patchId,
      tmpRoot,
    );

    const result = signAndVerify(patchId);
    expect(result.status).toBe('valid');
    expect(result.overallIndependenceTier).toBe('none');
  });

  it('all leaves independenceTier=isolated ⇒ overallIndependenceTier=isolated', () => {
    const patchId = '3'.repeat(40);
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 0, reviewerName: 'code-reviewer', independenceTier: 'isolated' }),
      patchId,
      tmpRoot,
    );
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer', independenceTier: 'isolated' }),
      patchId,
      tmpRoot,
    );

    const result = signAndVerify(patchId);
    expect(result.status).toBe('valid');
    expect(result.overallIndependenceTier).toBe('isolated');
  });

  it('mixed attested + isolated (no none) ⇒ overallIndependenceTier=attested (not all isolated)', () => {
    const patchId = '4'.repeat(40);
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 0, reviewerName: 'code-reviewer', independenceTier: 'attested' }),
      patchId,
      tmpRoot,
    );
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer', independenceTier: 'isolated' }),
      patchId,
      tmpRoot,
    );

    const result = signAndVerify(patchId);
    expect(result.status).toBe('valid');
    expect(result.overallIndependenceTier).toBe('attested');
  });
});

describe('RFC-0046 Phase 1: dual-read migration (independenceTier <-> legacy verdictClass)', () => {
  it('legacy envelope with only verdictClass=independent yields overallIndependenceTier=attested via fallback', () => {
    const patchId = '5'.repeat(40);
    // Leaves omit independenceTier entirely — pre-RFC-0046 shape.
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 0, reviewerName: 'code-reviewer', verdictClass: 'independent' }),
      patchId,
      tmpRoot,
    );
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer', verdictClass: 'independent' }),
      patchId,
      tmpRoot,
    );

    const result = signAndVerify(patchId);
    expect(result.status).toBe('valid');
    expect(result.overallIndependenceTier).toBe('attested');
  });

  it('legacy envelope with verdictClass=self-authored (or absent) yields overallIndependenceTier=none via fallback', () => {
    const patchId = '6'.repeat(40);
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 0, reviewerName: 'code-reviewer', verdictClass: 'self-authored' }),
      patchId,
      tmpRoot,
    );
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer' }), // verdictClass entirely absent
      patchId,
      tmpRoot,
    );

    const result = signAndVerify(patchId);
    expect(result.status).toBe('valid');
    expect(result.overallIndependenceTier).toBe('none');
  });

  it('a new envelope with independenceTier set IGNORES a contradicting legacy verdictClass', () => {
    const patchId = '7'.repeat(40);
    // verdictClass says self-authored (would map to 'none'), but the new
    // independenceTier signal explicitly says 'attested' — the new field
    // wins; verdictClass is not consulted when independenceTier is present.
    appendLeafForPatchId(
      makeLeaf({
        leafIndex: 0,
        reviewerName: 'code-reviewer',
        verdictClass: 'self-authored',
        independenceTier: 'attested',
      }),
      patchId,
      tmpRoot,
    );

    const result = signAndVerify(patchId);
    expect(result.status).toBe('valid');
    expect(result.overallIndependenceTier).toBe('attested');
  });
});

describe('RFC-0046 Phase 1: tamper rejection (declared independenceTier != on-disk)', () => {
  it('rejects when the envelope claims a higher independenceTier than the on-disk leaf resolves to', () => {
    const patchId = '8'.repeat(40);
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 0, reviewerName: 'code-reviewer', independenceTier: 'attested' }),
      patchId,
      tmpRoot,
    );

    const outPath = signAndWriteV6Envelope({
      repoRoot: tmpRoot,
      headSha: FAKE_HEAD_SHA,
      taskId: 'AISDLC-588',
      privateKeyPem,
      patchId,
    });
    const envelope = JSON.parse(readFileSync(outPath, 'utf8'));

    // Sanity: unmodified envelope verifies clean.
    expect(verifyEnvelope(envelope, patchId).status).toBe('valid');

    // Tamper: escalate the DECLARED (envelope-copy) independenceTier without
    // touching the on-disk leaf or re-signing. The Merkle root + signature
    // were computed over the ORIGINAL on-disk leaf, so this tamper does not
    // change the recomputed root — it must be caught by the explicit 7c
    // declared-vs-on-disk equality check, not by signature failure.
    envelope.transcriptLeaves[0].independenceTier = 'isolated';

    const tamperedResult = verifyEnvelope(envelope, patchId);
    expect(tamperedResult.status).toBe('invalid');
    expect(tamperedResult.reason).toContain('independenceTier mismatch');
  });

  it('rejects an out-of-enum declared independenceTier value', () => {
    const patchId = '9'.repeat(40);
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 0, reviewerName: 'code-reviewer', independenceTier: 'attested' }),
      patchId,
      tmpRoot,
    );

    const outPath = signAndWriteV6Envelope({
      repoRoot: tmpRoot,
      headSha: FAKE_HEAD_SHA,
      taskId: 'AISDLC-588',
      privateKeyPem,
      patchId,
    });
    const envelope = JSON.parse(readFileSync(outPath, 'utf8'));
    envelope.transcriptLeaves[0].independenceTier = 'super-duper-independent';

    const result = verifyEnvelope(envelope, patchId);
    expect(result.status).toBe('invalid');
    expect(result.reason).toContain("must be 'none', 'attested', or 'isolated'");
  });

  it('rejects when the on-disk leaf is tampered to a different independenceTier post-sign (root mismatch)', () => {
    // This tampers the AUTHORITATIVE on-disk source, so the recomputed
    // Merkle root diverges from the signed rootHash — caught by the
    // rootSignature check (step 5), same failure mode as the AISDLC-579
    // transcriptHash-tamper precedent.
    const patchId = 'a'.repeat(40);
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 0, reviewerName: 'code-reviewer', independenceTier: 'attested' }),
      patchId,
      tmpRoot,
    );
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer', independenceTier: 'attested' }),
      patchId,
      tmpRoot,
    );

    const outPath = signAndWriteV6Envelope({
      repoRoot: tmpRoot,
      headSha: FAKE_HEAD_SHA,
      taskId: 'AISDLC-588',
      privateKeyPem,
      patchId,
    });
    const envelope = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(verifyEnvelope(envelope, patchId).status).toBe('valid');

    const leavesPath = join(tmpRoot, '.ai-sdlc', 'transcript-leaves', `${patchId}.jsonl`);
    const lines = readFileSync(leavesPath, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[0]);
    tampered.independenceTier = 'isolated'; // was 'attested'
    lines[0] = JSON.stringify(tampered);
    writeFileSync(leavesPath, lines.join('\n') + '\n', 'utf8');

    const result = verifyEnvelope(envelope, patchId);
    expect(result.status).toBe('invalid');
    expect(result.reason).toContain('rootSignature');
  });
});
