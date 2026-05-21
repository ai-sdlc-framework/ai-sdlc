/**
 * Hermetic tests for RFC-0042 §Layers 2-3 Merkle implementation.
 *
 * Coverage targets:
 *   - Single-leaf tree
 *   - Multi-leaf tree (determinism, root stability)
 *   - Inclusion proof verification (valid and invalid)
 *   - Append idempotency (re-appending same leaf produces valid state)
 *   - Tampered-leaf detection (proof should fail)
 *   - Nonce generation (32-byte hex, PR-bound)
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LEAVES_FILE_RELATIVE,
  appendLeaf,
  computeMerkleRoot,
  generateNonce,
  hashLeaf,
  loadLeaves,
  sha256,
  verifyInclusion,
  type TranscriptLeaf,
} from './merkle.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeLeaf(overrides: Partial<TranscriptLeaf> = {}): TranscriptLeaf {
  return {
    leafIndex: 0,
    taskId: 'AISDLC-383.2',
    reviewerName: 'code-reviewer',
    transcriptHash: 'a'.repeat(64),
    nonce: 'b'.repeat(64),
    harness: 'claude-code',
    model: 'sonnet',
    verdictApproved: true,
    findings: { critical: 0, major: 0, minor: 1, suggestion: 0 },
    signedAt: '2026-05-20T19:14:37.561Z',
    ...overrides,
  };
}

// ── sha256 ────────────────────────────────────────────────────────────────────

describe('sha256', () => {
  it('returns a 64-char lowercase hex string', () => {
    const h = sha256('hello');
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(sha256('test')).toBe(sha256('test'));
  });

  it('differs for different inputs', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });
});

// ── hashLeaf ──────────────────────────────────────────────────────────────────

describe('hashLeaf', () => {
  it('returns a 64-char hex string', () => {
    const h = hashLeaf(makeLeaf());
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same leaf produces same hash', () => {
    const leaf = makeLeaf();
    expect(hashLeaf(leaf)).toBe(hashLeaf(leaf));
  });

  it('differs when any field changes', () => {
    const base = makeLeaf();
    const changed = makeLeaf({ verdictApproved: false });
    expect(hashLeaf(base)).not.toBe(hashLeaf(changed));
  });

  it('differs when taskId changes', () => {
    expect(hashLeaf(makeLeaf({ taskId: 'AISDLC-1' }))).not.toBe(
      hashLeaf(makeLeaf({ taskId: 'AISDLC-2' })),
    );
  });
});

// ── computeMerkleRoot — empty ─────────────────────────────────────────────────

describe('computeMerkleRoot — empty input', () => {
  it('returns empty root and empty proofs', () => {
    const { root, proofs } = computeMerkleRoot([]);
    expect(root).toBe('');
    expect(proofs).toEqual({});
  });
});

// ── computeMerkleRoot — single leaf ──────────────────────────────────────────

describe('computeMerkleRoot — single leaf', () => {
  it('root equals the leaf hash', () => {
    const leaf = makeLeaf({ leafIndex: 0 });
    const { root, proofs } = computeMerkleRoot([leaf]);
    expect(root).toBe(hashLeaf(leaf));
    expect(proofs[0]).toEqual([]);
  });

  it('inclusion proof verifies', () => {
    const leaf = makeLeaf({ leafIndex: 0 });
    const { root, proofs } = computeMerkleRoot([leaf]);
    expect(verifyInclusion(hashLeaf(leaf), proofs[0], root, 0)).toBe(true);
  });
});

// ── computeMerkleRoot — multi-leaf ───────────────────────────────────────────

describe('computeMerkleRoot — multi-leaf', () => {
  it('two leaves produce a non-empty root', () => {
    const leaves = [
      makeLeaf({ leafIndex: 0 }),
      makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer' }),
    ];
    const { root } = computeMerkleRoot(leaves);
    expect(root).toHaveLength(64);
    expect(root).toMatch(/^[0-9a-f]{64}$/);
  });

  it('root is deterministic — same leaves produce same root', () => {
    const leaves = [
      makeLeaf({ leafIndex: 0 }),
      makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer' }),
      makeLeaf({ leafIndex: 2, reviewerName: 'security-reviewer' }),
    ];
    const r1 = computeMerkleRoot(leaves).root;
    const r2 = computeMerkleRoot(leaves).root;
    expect(r1).toBe(r2);
  });

  it('root changes when a leaf changes', () => {
    const leaves = [makeLeaf({ leafIndex: 0 }), makeLeaf({ leafIndex: 1 })];
    const r1 = computeMerkleRoot(leaves).root;
    const modified = [
      makeLeaf({ leafIndex: 0, verdictApproved: false }),
      makeLeaf({ leafIndex: 1 }),
    ];
    const r2 = computeMerkleRoot(modified).root;
    expect(r1).not.toBe(r2);
  });

  it('all inclusion proofs verify for 4 leaves (even count)', () => {
    const leaves = [0, 1, 2, 3].map((i) =>
      makeLeaf({ leafIndex: i, reviewerName: `reviewer-${i}` }),
    );
    const { root, proofs } = computeMerkleRoot(leaves);
    for (let i = 0; i < leaves.length; i++) {
      expect(verifyInclusion(hashLeaf(leaves[i]), proofs[i], root, i)).toBe(true);
    }
  });

  it('all inclusion proofs verify for 5 leaves (odd count)', () => {
    const leaves = [0, 1, 2, 3, 4].map((i) =>
      makeLeaf({ leafIndex: i, reviewerName: `reviewer-${i}` }),
    );
    const { root, proofs } = computeMerkleRoot(leaves);
    for (let i = 0; i < leaves.length; i++) {
      expect(verifyInclusion(hashLeaf(leaves[i]), proofs[i], root, i)).toBe(true);
    }
  });

  it('all inclusion proofs verify for 3 leaves (odd count)', () => {
    const leaves = [0, 1, 2].map((i) => makeLeaf({ leafIndex: i, reviewerName: `reviewer-${i}` }));
    const { root, proofs } = computeMerkleRoot(leaves);
    for (let i = 0; i < leaves.length; i++) {
      expect(verifyInclusion(hashLeaf(leaves[i]), proofs[i], root, i)).toBe(true);
    }
  });
});

// ── verifyInclusion — tampered leaf ──────────────────────────────────────────

describe('verifyInclusion — tampered leaf detection', () => {
  it('returns false when leaf hash is wrong', () => {
    const leaves = [makeLeaf({ leafIndex: 0 }), makeLeaf({ leafIndex: 1 })];
    const { root, proofs } = computeMerkleRoot(leaves);
    const tamperedHash = 'f'.repeat(64);
    expect(verifyInclusion(tamperedHash, proofs[0], root, 0)).toBe(false);
  });

  it('returns false when root is wrong', () => {
    const leaves = [makeLeaf({ leafIndex: 0 }), makeLeaf({ leafIndex: 1 })];
    const { proofs } = computeMerkleRoot(leaves);
    const wrongRoot = 'a'.repeat(64);
    expect(verifyInclusion(hashLeaf(leaves[0]), proofs[0], wrongRoot, 0)).toBe(false);
  });

  it('returns false when proof path is tampered', () => {
    const leaves = [
      makeLeaf({ leafIndex: 0 }),
      makeLeaf({ leafIndex: 1 }),
      makeLeaf({ leafIndex: 2 }),
    ];
    const { root, proofs } = computeMerkleRoot(leaves);
    const tamperedProof = proofs[0].map(() => 'c'.repeat(64));
    expect(verifyInclusion(hashLeaf(leaves[0]), tamperedProof, root, 0)).toBe(false);
  });

  it('returns false for empty leaf hash', () => {
    const leaves = [makeLeaf({ leafIndex: 0 })];
    const { root, proofs } = computeMerkleRoot(leaves);
    expect(verifyInclusion('', proofs[0], root, 0)).toBe(false);
  });

  it('returns false for empty root', () => {
    const leaves = [makeLeaf({ leafIndex: 0 })];
    const { proofs } = computeMerkleRoot(leaves);
    expect(verifyInclusion(hashLeaf(leaves[0]), proofs[0], '', 0)).toBe(false);
  });

  it('returns false when using a proof for the wrong leaf index', () => {
    const leaves = [0, 1, 2, 3].map((i) =>
      makeLeaf({ leafIndex: i, reviewerName: `reviewer-${i}` }),
    );
    const { root, proofs } = computeMerkleRoot(leaves);
    // Proof for leaf 0, but claiming it is for leaf 1 — wrong direction.
    expect(verifyInclusion(hashLeaf(leaves[0]), proofs[0], root, 1)).toBe(false);
  });
});

// ── generateNonce ─────────────────────────────────────────────────────────────

describe('generateNonce', () => {
  it('returns a 64-char hex string (32 bytes)', () => {
    const nonce = generateNonce('abc123headsha');
    expect(nonce).toHaveLength(64);
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is different on each call (random component)', () => {
    const n1 = generateNonce('sameSha');
    const n2 = generateNonce('sameSha');
    expect(n1).not.toBe(n2);
  });

  it('differs for different head SHAs', () => {
    // Both calls have random components, collision probability is 2^-256.
    const n1 = generateNonce('sha-A');
    const n2 = generateNonce('sha-B');
    expect(n1).not.toBe(n2);
  });
});

// ── loadLeaves / appendLeaf ───────────────────────────────────────────────────

describe('loadLeaves', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'merkle-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns empty array when file does not exist', () => {
    expect(loadLeaves(tmp)).toEqual([]);
  });

  it('round-trips a single leaf', () => {
    const leaf = makeLeaf({ leafIndex: 0 });
    appendLeaf(leaf, tmp);
    const loaded = loadLeaves(tmp);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(leaf);
  });

  it('round-trips multiple leaves in order', () => {
    const leaves = [
      makeLeaf({ leafIndex: 0 }),
      makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer' }),
      makeLeaf({ leafIndex: 2, reviewerName: 'security-reviewer' }),
    ];
    for (const leaf of leaves) {
      appendLeaf(leaf, tmp);
    }
    const loaded = loadLeaves(tmp);
    expect(loaded).toHaveLength(3);
    expect(loaded).toEqual(leaves);
  });

  it('skips corrupt lines and reads valid ones', () => {
    const leavesFile = join(tmp, LEAVES_FILE_RELATIVE);
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    const leaf0 = makeLeaf({ leafIndex: 0 });
    const leaf2 = makeLeaf({ leafIndex: 2, reviewerName: 'security-reviewer' });
    const content =
      JSON.stringify(leaf0) + '\n' + 'NOT VALID JSON ~~~\n' + JSON.stringify(leaf2) + '\n';
    writeFileSync(leavesFile, content, 'utf8');
    const loaded = loadLeaves(tmp);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toEqual(leaf0);
    expect(loaded[1]).toEqual(leaf2);
  });
});

describe('appendLeaf', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'merkle-append-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the file and directory if they do not exist', () => {
    const leaf = makeLeaf({ leafIndex: 0 });
    appendLeaf(leaf, tmp);
    expect(existsSync(join(tmp, LEAVES_FILE_RELATIVE))).toBe(true);
  });

  it('appends without losing previous leaves', () => {
    const leaf0 = makeLeaf({ leafIndex: 0 });
    const leaf1 = makeLeaf({ leafIndex: 1 });
    appendLeaf(leaf0, tmp);
    appendLeaf(leaf1, tmp);
    const loaded = loadLeaves(tmp);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toEqual(leaf0);
    expect(loaded[1]).toEqual(leaf1);
  });

  it('does not leave a .tmp file behind on success', () => {
    const leaf = makeLeaf({ leafIndex: 0 });
    appendLeaf(leaf, tmp);
    expect(existsSync(join(tmp, LEAVES_FILE_RELATIVE) + '.tmp')).toBe(false);
  });

  it('append idempotency — appending same leaf twice produces 2 entries (no dedup)', () => {
    // The API does not deduplicate — caller is responsible for leafIndex uniqueness.
    const leaf = makeLeaf({ leafIndex: 0 });
    appendLeaf(leaf, tmp);
    appendLeaf(leaf, tmp);
    const loaded = loadLeaves(tmp);
    expect(loaded).toHaveLength(2);
  });
});

// ── End-to-end: append + compute + verify ─────────────────────────────────────

describe('end-to-end: append → compute → verify', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'merkle-e2e-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('3 leaves appended, all inclusion proofs verify against computed root', () => {
    const leaves = [
      makeLeaf({ leafIndex: 0, reviewerName: 'code-reviewer' }),
      makeLeaf({ leafIndex: 1, reviewerName: 'test-reviewer' }),
      makeLeaf({ leafIndex: 2, reviewerName: 'security-reviewer' }),
    ];
    for (const leaf of leaves) {
      appendLeaf(leaf, tmp);
    }

    const loaded = loadLeaves(tmp);
    const { root, proofs } = computeMerkleRoot(loaded);

    expect(root).toHaveLength(64);
    for (let i = 0; i < loaded.length; i++) {
      expect(verifyInclusion(hashLeaf(loaded[i]), proofs[i], root, i)).toBe(true);
    }
  });

  it('tampered leaf fails verification against original root', () => {
    const leaves = [makeLeaf({ leafIndex: 0 }), makeLeaf({ leafIndex: 1 })];
    for (const leaf of leaves) appendLeaf(leaf, tmp);

    const loaded = loadLeaves(tmp);
    const { root, proofs } = computeMerkleRoot(loaded);

    // Tamper with leaf 0.
    const tampered = { ...loaded[0], verdictApproved: false };
    expect(verifyInclusion(hashLeaf(tampered), proofs[0], root, 0)).toBe(false);
  });
});
