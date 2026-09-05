/**
 * Type declarations for the canonical Merkle primitives in `merkle-core.mjs`
 * (AISDLC-579 single-sourcing). See that file for the full rationale.
 *
 * This interface is intentionally self-contained (not imported from
 * `pipeline-cli/src/attestation/merkle.ts`) so `merkle-core.mjs` has zero
 * compile-time coupling back into `src/` — it is consumed as-is by both the
 * TypeScript build (`merkle.ts` re-exports these) and the plain-ESM verifier
 * (`verify-core.mjs`), which must never require a `dist/` build to exist.
 */

export interface MerkleCoreLeaf {
  leafIndex: number;
  taskId: string;
  reviewerName: string;
  transcriptHash: string;
  nonce: string;
  harness: string;
  model: string;
  verdictApproved: boolean;
  findings: {
    critical: number;
    major: number;
    minor: number;
    suggestion: number;
  };
  signedAt: string;
  verdictClass?: 'independent' | 'self-authored';
  harnessTranscriptHash?: string | null;
}

export interface MerkleCoreResult {
  root: string;
  proofs: Record<number, string[]>;
}

export function hashPair(left: string, right: string): string;
export function hashLeaf(leaf: MerkleCoreLeaf): string;
export function computeMerkleRoot(leaves: MerkleCoreLeaf[]): MerkleCoreResult;
export function verifyInclusion(
  leafHash: string,
  proof: string[],
  root: string,
  leafIndex: number,
  leafCount: number,
): boolean;
