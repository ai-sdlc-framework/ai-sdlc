/**
 * Names the staged review shares between its leaf manifest, verdict and the
 * `emit-leaf` ledger write, plus the diff-binding nonce.
 *
 * @module attestation/staged-review
 */

import { createHash, randomBytes } from 'node:crypto';

/** The stages of the staged review that run a model and so produce a transcript. */
export const STAGED_LEAF_STAGES = ['plan', 'execute', 'synthesize'] as const;
export type StagedLeafStage = (typeof STAGED_LEAF_STAGES)[number];

/** `reviewerName` of every transcript the staged set produces, and the name of its verdict. */
export const STAGED_REVIEWER_NAME = 'staged-review';

/**
 * Generate a diff-binding nonce for a PR head SHA: 32 bytes of hex derived from the
 * head SHA and a random component. The nonce is embedded in a reviewer's prompt and
 * matched against the harness transcript, so a transcript is bound to this diff.
 */
export function generateNonce(headSha: string): string {
  const random = randomBytes(16).toString('hex');
  return createHash('sha256').update(headSha, 'utf8').update(random, 'utf8').digest('hex');
}
