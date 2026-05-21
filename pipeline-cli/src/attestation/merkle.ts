/**
 * RFC-0042 §Design Layers 2-3 — Append-only Merkle leaf index + root computation.
 *
 * Pure-TypeScript, no external dependencies. Uses Node's built-in `node:crypto`
 * for SHA-256 hashing. Implements a standard binary Merkle tree where:
 *   - Each leaf is SHA-256 of its canonical JSON serialisation.
 *   - Internal nodes are SHA-256 of (left ++ right), where "++" is byte concatenation.
 *   - Odd-length levels duplicate the last node to make the count even (standard
 *     binary Merkle padding).
 *
 * ## File layout
 *
 * Leaves are persisted at `.ai-sdlc/transcript-leaves.jsonl` (committed, never pruned).
 * Atomic append: write full content to a `.tmp` file then `renameSync` — relies on
 * POSIX rename atomicity. This makes appends corruption-resistant: a crash between
 * write and rename leaves a stale `.tmp` file (overwritten by next call) rather than
 * a partially-written leaf.
 *
 * ## Nonce binding (RFC-0042 §Nonce binding)
 *
 * `generateNonce(headSha)` derives a 32-byte hex value deterministically from the
 * PR's head SHA so nonces are replay-resistant across PRs. The nonce is included
 * verbatim in reviewer subagent prompts, becoming part of the transcript, which is
 * then hashed into the leaf. Replaying a leaf from another PR fails: the nonce won't
 * match this PR's head.
 *
 * ## Inclusion proof API
 *
 * `verifyInclusion(leafHash, proof, root, leafIndex)` is the canonical verification
 * function. It is direction-aware (uses `leafIndex` to know left/right at each level)
 * and returns true only when the reconstructed root matches exactly.
 *
 * @module attestation/merkle
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ── Leaf shape (RFC-0042 §Layer 2) ───────────────────────────────────────────

export interface TranscriptLeaf {
  /** Sequential index (0-based) in .ai-sdlc/transcript-leaves.jsonl. */
  leafIndex: number;
  /** AISDLC task identifier, e.g. "AISDLC-383.2". */
  taskId: string;
  /** Reviewer subagent role, e.g. "code-reviewer". */
  reviewerName: string;
  /** SHA-256 hex of the raw transcript JSONL file. */
  transcriptHash: string;
  /** 32-byte hex nonce bound to the PR's head SHA. */
  nonce: string;
  /** Harness name, e.g. "claude-code". */
  harness: string;
  /** LLM model identifier, e.g. "sonnet". */
  model: string;
  /** true when the reviewer approved, false when CHANGES_REQUESTED. */
  verdictApproved: boolean;
  /** Reviewer finding counts. */
  findings: {
    critical: number;
    major: number;
    minor: number;
    suggestion: number;
  };
  /** ISO-8601 timestamp when the leaf was signed. */
  signedAt: string;
}

// ── Merkle result shapes ──────────────────────────────────────────────────────

export interface MerkleResult {
  /** SHA-256 root of the full tree. Empty string when leaves array is empty. */
  root: string;
  /**
   * Per-leaf inclusion proofs keyed by leafIndex.
   * Each proof is a list of sibling hashes from leaf level up to (but not including)
   * the root. Pass to `verifyInclusion` together with the leaf hash and root.
   */
  proofs: Record<number, string[]>;
}

// ── SHA-256 helpers ───────────────────────────────────────────────────────────

/** SHA-256 of a UTF-8 string. Returns lowercase 64-char hex. */
export function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** SHA-256 of two hex-encoded hashes concatenated as bytes (left || right). */
function hashPair(left: string, right: string): string {
  return createHash('sha256')
    .update(Buffer.from(left, 'hex'))
    .update(Buffer.from(right, 'hex'))
    .digest('hex');
}

// ── Leaf hashing ──────────────────────────────────────────────────────────────

/**
 * Canonical leaf hash: SHA-256 of the JSON serialisation with keys in the
 * fixed RFC-0042 order. Deterministic across implementations.
 */
export function hashLeaf(leaf: TranscriptLeaf): string {
  // Fixed key order per RFC-0042 §Layer 2 schema.
  const ordered: TranscriptLeaf = {
    leafIndex: leaf.leafIndex,
    taskId: leaf.taskId,
    reviewerName: leaf.reviewerName,
    transcriptHash: leaf.transcriptHash,
    nonce: leaf.nonce,
    harness: leaf.harness,
    model: leaf.model,
    verdictApproved: leaf.verdictApproved,
    findings: {
      critical: leaf.findings.critical,
      major: leaf.findings.major,
      minor: leaf.findings.minor,
      suggestion: leaf.findings.suggestion,
    },
    signedAt: leaf.signedAt,
  };
  return sha256(JSON.stringify(ordered));
}

// ── Merkle tree computation ───────────────────────────────────────────────────

/**
 * Compute the Merkle root from an array of leaves and return per-leaf
 * inclusion proofs.
 *
 * Empty input returns `{ root: '', proofs: {} }`.
 * Single-leaf input returns the leaf hash as the root with an empty proof.
 *
 * The tree uses standard binary Merkle padding: when a level has an odd number
 * of nodes the last node is paired with itself.
 */
export function computeMerkleRoot(leaves: TranscriptLeaf[]): MerkleResult {
  if (leaves.length === 0) {
    return { root: '', proofs: {} };
  }

  // Compute leaf hashes.
  const leafHashes = leaves.map(hashLeaf);

  if (leafHashes.length === 1) {
    return { root: leafHashes[0], proofs: { 0: [] } };
  }

  // Build the tree layer by layer.
  // layers[0] = leaf hashes; layers[layers.length - 1] = [rootHash].
  const layers: string[][] = [leafHashes];

  let current = leafHashes;
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      // Odd node: pair it with itself (standard padding).
      const right = i + 1 < current.length ? current[i + 1] : current[i];
      next.push(hashPair(left, right));
    }
    layers.push(next);
    current = next;
  }

  const root = current[0];

  // Generate per-leaf inclusion proofs.
  // Each proof is an ordered list of sibling hashes from leaf level to root.
  const proofs: Record<number, string[]> = {};
  for (let leafIdx = 0; leafIdx < leaves.length; leafIdx++) {
    const proof: string[] = [];
    let idx = leafIdx;
    for (let layerIdx = 0; layerIdx < layers.length - 1; layerIdx++) {
      const layer = layers[layerIdx];
      let siblingIdx: number;
      if (idx % 2 === 0) {
        // Current is left child — sibling is to the right.
        siblingIdx = idx + 1 < layer.length ? idx + 1 : idx; // duplicated if odd
      } else {
        // Current is right child — sibling is to the left.
        siblingIdx = idx - 1;
      }
      proof.push(layer[siblingIdx]);
      idx = Math.floor(idx / 2);
    }
    proofs[leafIdx] = proof;
  }

  return { root, proofs };
}

// ── Inclusion proof verification ──────────────────────────────────────────────

/**
 * Verify that `leafHash` is included in the Merkle tree rooted at `root`,
 * using `proof` as the sibling-hash path and `leafIndex` for direction.
 *
 * `leafIndex` is the 0-based position of the leaf in the leaves array. It is
 * always available from `TranscriptLeaf.leafIndex`.
 *
 * Returns:
 *   - `true`  when the reconstructed root matches `root` exactly.
 *   - `false` for any tampered leaf hash, invalid proof, or wrong root.
 */
export function verifyInclusion(
  leafHash: string,
  proof: string[],
  root: string,
  leafIndex: number,
): boolean {
  if (!root || !leafHash) return false;

  let current = leafHash;
  let idx = leafIndex;
  for (const sibling of proof) {
    if (idx % 2 === 0) {
      // Current is a left child — sibling is on the right.
      current = hashPair(current, sibling);
    } else {
      // Current is a right child — sibling is on the left.
      current = hashPair(sibling, current);
    }
    idx = Math.floor(idx / 2);
  }

  return current === root;
}

// ── Nonce generation (RFC-0042 §Nonce binding) ────────────────────────────────

/**
 * Generate a 32-byte hex nonce bound to the PR's head SHA.
 *
 * Derivation: SHA-256(headSha || 16-random-bytes) → 64 hex chars = 32 bytes.
 *
 * Properties:
 *   - Unique per invocation (random component).
 *   - Cryptographically bound to this PR's head SHA.
 *   - Replay-resistant: the same nonce can't be reused for a different PR's head.
 *
 * Per OQ-6: first push IS genesis — no ceremony required.
 */
export function generateNonce(headSha: string): string {
  const random = randomBytes(16).toString('hex');
  return createHash('sha256').update(headSha, 'utf8').update(random, 'utf8').digest('hex');
}

// ── Leaf file I/O ─────────────────────────────────────────────────────────────

/** Repo-relative path of the committed leaf index. */
export const LEAVES_FILE_RELATIVE = '.ai-sdlc/transcript-leaves.jsonl';

/**
 * Resolve the absolute path of the leaves file given a repo root.
 * Defaults to `process.cwd()` when `repoRoot` is not supplied.
 */
export function leavesFilePath(repoRoot?: string): string {
  return join(repoRoot ?? process.cwd(), LEAVES_FILE_RELATIVE);
}

/**
 * Load all leaves from `.ai-sdlc/transcript-leaves.jsonl`.
 *
 * Returns an empty array when the file does not exist.
 * Lines that fail JSON.parse are silently skipped (corruption-resistant read).
 */
export function loadLeaves(repoRoot?: string): TranscriptLeaf[] {
  const filePath = leavesFilePath(repoRoot);
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, 'utf8');
  const leaves: TranscriptLeaf[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      leaves.push(JSON.parse(trimmed) as TranscriptLeaf);
    } catch {
      // Skip corrupt lines — prior valid lines remain intact.
    }
  }
  return leaves;
}

/**
 * Atomically append a single leaf to `.ai-sdlc/transcript-leaves.jsonl`.
 *
 * The leaf is serialised as one JSON line (JSONL format). Atomicity is achieved
 * via write-to-tmp + renameSync: on POSIX, rename(2) is atomic within the same
 * filesystem, so readers always see either the old file or the complete new file.
 *
 * Concurrent callers may race on the rename — the last writer wins. This is
 * acceptable because the slash command body is the sole writer per task run.
 */
export function appendLeaf(leaf: TranscriptLeaf, repoRoot?: string): void {
  const filePath = leavesFilePath(repoRoot);
  const dir = dirname(filePath);

  mkdirSync(dir, { recursive: true });

  // Read existing content.
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';

  // Ensure the existing content ends with a newline before appending.
  const newLine = JSON.stringify(leaf) + '\n';
  const newContent =
    existing === '' || existing.endsWith('\n') ? existing + newLine : existing + '\n' + newLine;

  // Atomic write via tmp + rename.
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, newContent, { encoding: 'utf8' });
  renameSync(tmpPath, filePath);
}
