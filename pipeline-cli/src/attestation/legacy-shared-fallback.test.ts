/**
 * AISDLC-421 — hermetic legacy-envelope-via-shared-fallback test.
 *
 * AC #7: an envelope signed pre-AISDLC-421 (i.e. its leaves live in the
 * SHARED `.ai-sdlc/transcript-leaves.jsonl` file, not a per-patch-id file)
 * still verifies via the shared-file fallback.
 *
 * The pipeline-cli signer + the script verifier both implement the same
 * "per-patch-id-first, shared-file-fallback" contract per AC#2 + AC#3. This
 * test exercises the signer side: sign WITHOUT a per-patch-id file present
 * → the signer falls back to filtering the shared file by taskId → produces
 * a valid envelope that bundles those leaves as `transcriptLeaves[]`.
 *
 * The verifier side is exercised by the test added to scripts/verify-attestation.test.mjs.
 *
 * @module attestation/legacy-shared-fallback.test
 */

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendLeaf,
  appendLeafForPatchId,
  computeMerkleRoot,
  leavesFilePath,
  leavesFilePathForPatchId,
  loadLeavesForPatchId,
  type TranscriptLeaf,
} from './merkle.js';
import { signAndWriteV6Envelope, type AttestationEnvelopeV6 } from './sign-v6.js';

const FAKE_HEAD_SHA = 'c'.repeat(40);
const FAKE_PATCH_ID = 'd'.repeat(40);

function generateTestKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

function makeLeaf(overrides: Partial<TranscriptLeaf> = {}): TranscriptLeaf {
  return {
    leafIndex: 0,
    taskId: 'AISDLC-LEGACY',
    reviewerName: 'code-reviewer',
    transcriptHash: 'a'.repeat(64),
    nonce: 'b'.repeat(64),
    harness: 'claude-code',
    model: 'sonnet',
    verdictApproved: true,
    findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    signedAt: '2026-05-24T00:00:00.000Z',
    ...overrides,
  };
}

let tmpRoot: string;
let privateKeyPem: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'aisdlc-421-legacy-'));
  ({ privateKeyPem } = generateTestKeyPair());
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('AISDLC-421 — legacy shared-file fallback (AC#7)', () => {
  it('signs against the shared file when no per-patch-id file exists', () => {
    // Pre-AISDLC-421 state: leaves live in .ai-sdlc/transcript-leaves.jsonl.
    appendLeaf(makeLeaf({ leafIndex: 0, taskId: 'AISDLC-LEGACY' }), tmpRoot);
    appendLeaf(
      makeLeaf({ leafIndex: 1, taskId: 'AISDLC-LEGACY', reviewerName: 'test-reviewer' }),
      tmpRoot,
    );
    // (A leaf from a different task — should NOT be selected.)
    appendLeaf(
      makeLeaf({ leafIndex: 2, taskId: 'AISDLC-OTHER', reviewerName: 'security-reviewer' }),
      tmpRoot,
    );

    // No per-patch-id file exists.
    expect(existsSync(leavesFilePathForPatchId(FAKE_PATCH_ID, tmpRoot))).toBe(false);
    // The shared file exists with the 3 leaves we appended.
    expect(existsSync(leavesFilePath(tmpRoot))).toBe(true);

    const outPath = signAndWriteV6Envelope({
      repoRoot: tmpRoot,
      headSha: FAKE_HEAD_SHA,
      taskId: 'AISDLC-LEGACY',
      privateKeyPem,
      patchId: FAKE_PATCH_ID,
    });

    const envelope = JSON.parse(readFileSync(outPath, 'utf8')) as AttestationEnvelopeV6;

    // The shared-file fallback selected the 2 leaves matching the taskId
    // (filter is case-insensitive). The third leaf (different task) is excluded.
    expect(envelope.transcriptLeaves).toHaveLength(2);
    expect(envelope.leafCount).toBe(2);
    expect(envelope.subject.digest.sha1).toBe(FAKE_HEAD_SHA);
    expect(envelope.schemaVersion).toBe('v6');
  });

  it('prefers per-patch-id file when present (shared file ignored)', () => {
    // Mixed state: BOTH the per-patch-id file AND the shared file have leaves
    // for the same task. The per-patch-id file MUST win (it's the post-migration
    // canonical path); the shared file is ignored.
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 0, taskId: 'AISDLC-MIXED', reviewerName: 'fresh' }),
      FAKE_PATCH_ID,
      tmpRoot,
    );
    // Shared file has DIFFERENT leaves for the same task (e.g. left over from
    // a previous sign that wrote to the legacy path).
    appendLeaf(makeLeaf({ leafIndex: 0, taskId: 'AISDLC-MIXED', reviewerName: 'stale' }), tmpRoot);

    const outPath = signAndWriteV6Envelope({
      repoRoot: tmpRoot,
      headSha: FAKE_HEAD_SHA,
      taskId: 'AISDLC-MIXED',
      privateKeyPem,
      patchId: FAKE_PATCH_ID,
    });

    const envelope = JSON.parse(readFileSync(outPath, 'utf8')) as AttestationEnvelopeV6;

    // Only the per-patch-id leaf is included; the shared-file leaf is ignored.
    expect(envelope.transcriptLeaves).toHaveLength(1);
    expect(envelope.transcriptLeaves[0].reviewerName).toBe('fresh');
  });

  it('throws when neither per-patch-id nor shared file has leaves for the taskId', () => {
    // No leaves at all.
    expect(() =>
      signAndWriteV6Envelope({
        repoRoot: tmpRoot,
        headSha: FAKE_HEAD_SHA,
        taskId: 'AISDLC-NOTHING',
        privateKeyPem,
        patchId: FAKE_PATCH_ID,
      }),
    ).toThrow(/No transcript leaves found/);

    // Shared file has leaves but for a DIFFERENT task.
    appendLeaf(makeLeaf({ leafIndex: 0, taskId: 'AISDLC-OTHER' }), tmpRoot);
    expect(() =>
      signAndWriteV6Envelope({
        repoRoot: tmpRoot,
        headSha: FAKE_HEAD_SHA,
        taskId: 'AISDLC-NOTHING',
        privateKeyPem,
        patchId: FAKE_PATCH_ID,
      }),
    ).toThrow(/No transcript leaves found/);
  });

  it('per-patch-id sign produces self-consistent root recomputable from the file', () => {
    // This is the post-AISDLC-421 canonical path: writer wrote to per-patch-id
    // file → signer reads from per-patch-id file → root = f(this PR's leaves).
    // The verifier (in scripts/verify-attestation.mjs) recomputes the root
    // from the same per-patch-id file and asserts it matches the signed root.
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 0, taskId: 'AISDLC-FRESH', reviewerName: 'code-reviewer' }),
      FAKE_PATCH_ID,
      tmpRoot,
    );
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 1, taskId: 'AISDLC-FRESH', reviewerName: 'test-reviewer' }),
      FAKE_PATCH_ID,
      tmpRoot,
    );
    appendLeafForPatchId(
      makeLeaf({ leafIndex: 2, taskId: 'AISDLC-FRESH', reviewerName: 'security-reviewer' }),
      FAKE_PATCH_ID,
      tmpRoot,
    );

    const outPath = signAndWriteV6Envelope({
      repoRoot: tmpRoot,
      headSha: FAKE_HEAD_SHA,
      taskId: 'AISDLC-FRESH',
      privateKeyPem,
      patchId: FAKE_PATCH_ID,
    });
    const envelope = JSON.parse(readFileSync(outPath, 'utf8')) as AttestationEnvelopeV6;

    // Recompute root from the per-patch-id file (mirrors the verifier).
    const onDisk = loadLeavesForPatchId(FAKE_PATCH_ID, tmpRoot);
    expect(onDisk).toHaveLength(3);
    const { root: recomputedRoot } = computeMerkleRoot(onDisk);
    expect(recomputedRoot).toBe(envelope.rootHash);
    expect(envelope.leafCount).toBe(3);
  });
});
