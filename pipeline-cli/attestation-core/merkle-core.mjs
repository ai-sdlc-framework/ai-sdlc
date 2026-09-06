/**
 * RFC-0042 §Design Layers 2-3 — canonical Merkle leaf hashing + root
 * computation (AISDLC-579).
 *
 * ## Why this file exists (single-sourcing rationale)
 *
 * Prior to AISDLC-579, `pipeline-cli/src/attestation/merkle.ts` (the signer's
 * primitives) and `pipeline-cli/attestation-core/verify-core.mjs` (the
 * verifier's primitives, `v6HashLeaf`/`v6HashPair`/`v6ComputeMerkleRoot`)
 * were TWO INDEPENDENT implementations of the same RFC-6962 algorithm. They
 * drifted: `merkle.ts`'s `hashLeaf()` was updated by AISDLC-570 to include a
 * trailing `harnessTranscriptHash` field, but the verifier's inline copy was
 * never updated to match. The result: any v6 envelope containing a leaf with
 * a non-null `harnessTranscriptHash` produced a DIFFERENT Merkle root on the
 * verify side than the signer computed, and `rootSignature` verification
 * failed with "did not match any trusted reviewer pubkey" — even though the
 * signature was valid and no tampering had occurred.
 *
 * This file is now the ONE canonical implementation. Both
 * `pipeline-cli/src/attestation/merkle.ts` (compiled, imported by `sign-v6.ts`
 * and the rest of the TypeScript codebase) and
 * `pipeline-cli/attestation-core/verify-core.mjs` (plain, dependency-free ESM,
 * shipped without requiring a `dist/` build — see that file's header for the
 * full rationale) import the hashing/root functions from HERE. Neither file
 * defines its own copy anymore.
 *
 * This module is deliberately dependency-free (only `node:crypto`) so it can
 * be imported directly by `verify-core.mjs` without requiring a compiled
 * `pipeline-cli/dist/` to exist at runtime.
 *
 * ## Algorithm (RFC-6962 domain separation, CVE-2012-2459 mitigation)
 *
 *   - Each leaf is SHA-256 of (0x00 || canonical_json_utf8).
 *   - Internal nodes are SHA-256 of (0x01 || left_bytes || right_bytes).
 *   - Odd-length levels duplicate the last node to make the count even.
 *   - `verifyInclusion` requires `leafCount` and rejects
 *     `leafIndex >= leafCount` (out-of-bounds second-preimage defense).
 *
 * @module attestation-core/merkle-core
 */

import { createHash } from 'node:crypto';

const LEAF_DOMAIN = Buffer.from([0x00]);
const NODE_DOMAIN = Buffer.from([0x01]);

/** RFC-6962 leaf hash: SHA-256(0x00 || canonical_json_utf8). */
function hashLeafData(canonicalJson) {
  return createHash('sha256').update(LEAF_DOMAIN).update(canonicalJson, 'utf8').digest('hex');
}

/** RFC-6962 internal node hash: SHA-256(0x01 || left_bytes || right_bytes). */
export function hashPair(left, right) {
  return createHash('sha256')
    .update(NODE_DOMAIN)
    .update(Buffer.from(left, 'hex'))
    .update(Buffer.from(right, 'hex'))
    .digest('hex');
}

/**
 * Canonical leaf hash: SHA-256(0x00 || canonical_json_utf8) per RFC-6962.
 *
 * Fixed key order — this order is the CONTRACT that both the signer and the
 * verifier depend on. Do NOT reorder, add, or remove keys here without
 * updating every historical envelope's verifiability story (a key-order or
 * key-set change is a hash-breaking change for every already-signed leaf).
 *
 * `undefined` values (e.g. `verdictClass`/`harnessTranscriptHash`/
 * `independenceTier` absent on leaves signed before those fields existed)
 * are dropped by `JSON.stringify`, so historical leaves hash identically to
 * before their introducing field was added — backward compatible by
 * construction.
 */
export function hashLeaf(leaf) {
  const ordered = {
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
    // AISDLC-568: trailing field. `undefined` drops out of JSON.stringify.
    // FROZEN/legacy-read as of RFC-0046 (AISDLC-588) — superseded by
    // `independenceTier` below. Retained for backward compatibility; new
    // leaves should not rely on this field alone (see `independenceTier`).
    verdictClass: leaf.verdictClass,
    // AISDLC-570: trailing field. `undefined` drops out of JSON.stringify.
    harnessTranscriptHash: leaf.harnessTranscriptHash,
    // RFC-0046 / AISDLC-588: trailing field. `undefined` drops out of
    // JSON.stringify, so a leaf omitting it hashes identically to a
    // pre-independenceTier leaf. Superseded `verdictClass` as the primary
    // independence signal — 'none' | 'attested' | 'isolated'.
    independenceTier: leaf.independenceTier,
  };
  return hashLeafData(JSON.stringify(ordered));
}

/**
 * Compute the Merkle root from an array of leaves and return per-leaf
 * inclusion proofs, keyed by ARRAY POSITION (0-based index into `leaves`).
 *
 * Empty input returns `{ root: '', proofs: {} }`.
 * Single-leaf input returns the leaf hash as the root with an empty proof.
 *
 * Standard binary Merkle padding: an odd-length level duplicates its last
 * node to make the count even.
 *
 * CRITICAL (AISDLC-579): callers on both the sign and verify sides MUST pass
 * `leaves` in the SAME order (the append order of the on-disk JSONL leaves
 * file). `hashPair` is direction-sensitive — swapping the order of any two
 * leaves at a 2+-leaf tree produces a different root even though the SET of
 * leaves is identical.
 */
export function computeMerkleRoot(leaves) {
  if (leaves.length === 0) {
    return { root: '', proofs: {} };
  }

  const leafHashes = leaves.map(hashLeaf);

  if (leafHashes.length === 1) {
    return { root: leafHashes[0], proofs: { 0: [] } };
  }

  const layers = [leafHashes];
  let current = leafHashes;
  while (current.length > 1) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = i + 1 < current.length ? current[i + 1] : current[i];
      next.push(hashPair(left, right));
    }
    layers.push(next);
    current = next;
  }

  const root = current[0];

  const proofs = {};
  for (let leafIdx = 0; leafIdx < leaves.length; leafIdx++) {
    const proof = [];
    let idx = leafIdx;
    for (let layerIdx = 0; layerIdx < layers.length - 1; layerIdx++) {
      const layer = layers[layerIdx];
      const siblingIdx = idx % 2 === 0 ? (idx + 1 < layer.length ? idx + 1 : idx) : idx - 1;
      proof.push(layer[siblingIdx]);
      idx = Math.floor(idx / 2);
    }
    proofs[leafIdx] = proof;
  }

  return { root, proofs };
}

/**
 * Verify a Merkle inclusion proof.
 *
 * `leafIndex` is the 0-based ARRAY POSITION of the leaf (not
 * `TranscriptLeaf.leafIndex`). `leafCount` MUST be the total on-disk leaf
 * count (never trust a caller-supplied count) — bounds-checking prevents the
 * CVE-2012-2459-class second-preimage attack where an attacker claims
 * `leafIndex === leafCount` to land on a duplicated padding node.
 *
 * Returns `true` only when the reconstructed root matches `root` exactly AND
 * `leafIndex` is strictly less than `leafCount`.
 */
export function verifyInclusion(leafHash, proof, root, leafIndex, leafCount) {
  if (!root || !leafHash) return false;
  if (!Number.isInteger(leafCount) || leafCount <= 0) return false;
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leafCount) return false;

  let current = leafHash;
  let idx = leafIndex;
  for (const sibling of proof) {
    if (idx % 2 === 0) {
      current = hashPair(current, sibling);
    } else {
      current = hashPair(sibling, current);
    }
    idx = Math.floor(idx / 2);
  }

  return current === root;
}
