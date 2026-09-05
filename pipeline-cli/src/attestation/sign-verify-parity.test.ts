/**
 * AISDLC-579 — sign/verify Merkle root parity regression tests.
 *
 * ## Root cause (confirmed by hermetic repro before the fix)
 *
 * `pipeline-cli/src/attestation/merkle.ts` (the signer's `hashLeaf()`) and
 * `pipeline-cli/attestation-core/verify-core.mjs` (the verifier's inline
 * `v6HashLeaf()`) were TWO INDEPENDENT implementations of the same RFC-6962
 * leaf-hashing algorithm. AISDLC-570 added a trailing `harnessTranscriptHash`
 * field to `merkle.ts`'s `hashLeaf()` but the verifier's copy was never
 * updated to match. Result: any v6 envelope containing at least one leaf
 * with a non-null `harnessTranscriptHash` (the common case for a real
 * multi-reviewer PR where at least one reviewer ran under a harness that
 * captured its own execution transcript) recomputed a DIFFERENT Merkle root
 * on the verify side than the signer produced. Because `hashPair` folds
 * leaf hashes pairwise, this diverging LEAF hash propagates to the ROOT for
 * any 2+-leaf tree, and `rootSignature` verification then fails with
 * "did not match any trusted reviewer pubkey" — even though nothing was
 * tampered with and the same, valid key signed the (signer's) root.
 *
 * A 1-leaf tree with NO harnessTranscriptHash set happened to hash
 * identically on both sides (the divergent field was simply absent from
 * both computations), which is why single-leaf / harness-less envelopes
 * verified fine and masked the bug until a real multi-reviewer PR with a
 * harness-verified leaf hit it.
 *
 * ## The fix
 *
 * Both `merkle.ts` and `verify-core.mjs` now import the hashing/root/
 * inclusion-proof primitives from ONE canonical module,
 * `pipeline-cli/attestation-core/merkle-core.mjs` — see that file's header
 * for the full single-sourcing rationale.
 *
 * This file exercises the FULL sign → write → read-back → verify pipeline
 * (not just the bare primitives) so a future re-introduction of the
 * inline-duplicate pattern is caught at the envelope level, exactly the
 * shape production traffic hits.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLeafForPatchId, leavesFilePathForPatchId, type TranscriptLeaf } from './merkle.js';
import { signAndWriteV6Envelope } from './sign-v6.js';
// verify-core.mjs is a plain, dependency-free ESM sibling — no .d.ts, so this
// import is untyped at the TS boundary (matches verify-core-loader.ts's
// documented pattern for consuming this file).
// @ts-expect-error -- plain ESM, no type declarations shipped
import { verifyV6Envelope } from '../../attestation-core/verify-core.mjs';

function makeLeaf(overrides: Partial<TranscriptLeaf> = {}): TranscriptLeaf {
  return {
    leafIndex: 0,
    taskId: 'AISDLC-579',
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

let tmpRoot: string;
let privateKeyPem: string;
let publicKeyPem: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sign-verify-parity-'));
  const kp = generateKeyPairSync('ed25519');
  privateKeyPem = kp.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  publicKeyPem = kp.publicKey.export({ format: 'pem', type: 'spki' }) as string;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function signAndVerify(patchId: string) {
  const outPath = signAndWriteV6Envelope({
    repoRoot: tmpRoot,
    headSha: FAKE_HEAD_SHA,
    taskId: 'AISDLC-579',
    privateKeyPem,
    patchId,
  });
  const envelope = JSON.parse(readFileSync(outPath, 'utf8'));

  return verifyV6Envelope({
    envelope,
    envelopeFileName: `${FAKE_HEAD_SHA}.v6.dsse.json`,
    headSha: FAKE_HEAD_SHA,
    trustedReviewers: [{ pubkey: publicKeyPem }],
    repoRoot: tmpRoot,
    patchIdHint: patchId,
  }) as { status: string; reason: string };
}

describe('AISDLC-579: sign/verify Merkle root parity', () => {
  it('2-leaf envelope, one leaf carrying a harness-verified transcript (AISDLC-570), verifies clean', () => {
    const patchId = '2'.repeat(40);
    appendLeafForPatchId(
      makeLeaf({
        leafIndex: 0,
        reviewerName: 'code-reviewer',
        harnessTranscriptHash: 'f'.repeat(64),
      }),
      patchId,
      tmpRoot,
    );
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer' }),
      patchId,
      tmpRoot,
    );

    const result = signAndVerify(patchId);
    expect(result.status).toBe('valid');
  });

  it('2-leaf envelope with an EXPLICIT harnessTranscriptHash: null leaf verifies clean (AISDLC-576/579 exact case)', () => {
    // The precise value that broke AISDLC-575's attestation and was masked by
    // the AISDLC-576 strip workaround: emit-leaf writes `harnessTranscriptHash:
    // null` when no harness transcript is bound. JSON.stringify KEEPS null, so a
    // verifier whose hashLeaf omitted the field recomputed a different root. With
    // the single-sourced hashLeaf, sign and verify agree on null by construction.
    const patchId = '7'.repeat(40);
    appendLeafForPatchId(
      makeLeaf({
        leafIndex: 0,
        reviewerName: 'code-reviewer',
        harnessTranscriptHash: null,
      }),
      patchId,
      tmpRoot,
    );
    appendLeafForPatchId(
      makeLeaf({
        leafIndex: 1,
        reviewerName: 'security-reviewer',
        harnessTranscriptHash: null,
      }),
      patchId,
      tmpRoot,
    );

    const result = signAndVerify(patchId);
    expect(result.status).toBe('valid');
  });

  it('2-leaf envelope with no harness signal on either leaf verifies clean (baseline regression)', () => {
    const patchId = '3'.repeat(40);
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 0, reviewerName: 'code-reviewer' }),
      patchId,
      tmpRoot,
    );
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer' }),
      patchId,
      tmpRoot,
    );

    const result = signAndVerify(patchId);
    expect(result.status).toBe('valid');
  });

  it('3-leaf envelope (code/test/security reviewers, mixed harness signal) verifies clean', () => {
    const patchId = '4'.repeat(40);
    appendLeafForPatchId(
      makeLeaf({
        leafIndex: 0,
        reviewerName: 'code-reviewer',
        harnessTranscriptHash: 'a1'.repeat(32),
      }),
      patchId,
      tmpRoot,
    );
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer' }),
      patchId,
      tmpRoot,
    );
    appendLeafForPatchId(
      makeLeaf({
        leafIndex: 2,
        reviewerName: 'security-reviewer',
        harnessTranscriptHash: 'b2'.repeat(32),
      }),
      patchId,
      tmpRoot,
    );

    const result = signAndVerify(patchId);
    expect(result.status).toBe('valid');
  });

  it('leaves whose on-disk (file-append) order differs from ascending leafIndex still verify — neither side must re-sort', () => {
    // Simulate a write race: leafIndex 1 lands in the file BEFORE leafIndex 0
    // (e.g. two concurrent emit-leaf calls interleaving their writes). Both
    // the signer and the verifier read the SAME file in its literal line
    // order — as long as neither side re-sorts by leafIndex/reviewerName/
    // transcriptHash, the root each computes still matches because they
    // process the identical array in the identical order.
    const patchId = '5'.repeat(40);
    const filePath = leavesFilePathForPatchId(patchId, tmpRoot);
    const leaf1 = makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer' });
    const leaf0 = makeLeaf({
      leafIndex: 0,
      reviewerName: 'code-reviewer',
      harnessTranscriptHash: 'c3'.repeat(32),
    });
    // Write leaf1 BEFORE leaf0 — out-of-order relative to leafIndex.
    mkdirSync(join(tmpRoot, '.ai-sdlc', 'transcript-leaves'), { recursive: true });
    writeFileSync(filePath, JSON.stringify(leaf1) + '\n' + JSON.stringify(leaf0) + '\n', 'utf8');

    const result = signAndVerify(patchId);
    expect(result.status).toBe('valid');
  });

  it('tampering with a leaf transcriptHash after signing is detected (tamper detection still works)', () => {
    const patchId = '6'.repeat(40);
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 0, reviewerName: 'code-reviewer' }),
      patchId,
      tmpRoot,
    );
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer' }),
      patchId,
      tmpRoot,
    );

    const outPath = signAndWriteV6Envelope({
      repoRoot: tmpRoot,
      headSha: FAKE_HEAD_SHA,
      taskId: 'AISDLC-579',
      privateKeyPem,
      patchId,
    });
    const envelope = JSON.parse(readFileSync(outPath, 'utf8'));

    // Sanity: unmodified envelope verifies clean.
    const cleanResult = verifyV6Envelope({
      envelope,
      envelopeFileName: `${FAKE_HEAD_SHA}.v6.dsse.json`,
      headSha: FAKE_HEAD_SHA,
      trustedReviewers: [{ pubkey: publicKeyPem }],
      repoRoot: tmpRoot,
      patchIdHint: patchId,
    }) as { status: string; reason: string };
    expect(cleanResult.status).toBe('valid');

    // Tamper: mutate one on-disk leaf's transcriptHash AFTER signing —
    // the recomputed root must now differ from the signed rootHash, so
    // rootSignature verification must fail.
    const leavesPath = leavesFilePathForPatchId(patchId, tmpRoot);
    const lines = readFileSync(leavesPath, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[0]);
    tampered.transcriptHash = 'f'.repeat(64); // was 'a'.repeat(64)
    lines[0] = JSON.stringify(tampered);
    writeFileSync(leavesPath, lines.join('\n') + '\n', 'utf8');

    const tamperedResult = verifyV6Envelope({
      envelope,
      envelopeFileName: `${FAKE_HEAD_SHA}.v6.dsse.json`,
      headSha: FAKE_HEAD_SHA,
      trustedReviewers: [{ pubkey: publicKeyPem }],
      repoRoot: tmpRoot,
      patchIdHint: patchId,
    }) as { status: string; reason: string };
    expect(tamperedResult.status).toBe('invalid');
    expect(tamperedResult.reason).toContain('rootSignature');
  });
});
