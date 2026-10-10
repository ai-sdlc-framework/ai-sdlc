/**
 * Signer-side review-scope record (AISDLC-723).
 *
 * Derives the diff classification and the reviewer set that applied, so the
 * envelope can RECORD them. The record is informational: the CI verifier
 * (`verify-core.mjs` `enforceReviewScope`) re-derives the classification from
 * the diff and never reads this field, so a signer cannot assert a class.
 *
 * @module attestation/review-scope
 */

import { execFileSync } from 'node:child_process';
import {
  classifyReviewScope,
  parseSecurityReviewAlways,
  reviewerSetKindFor,
  type ReviewScopeClassification,
} from '../../attestation-core/review-scope-core.mjs';
import { PATCH_ID_EXCLUSIONS } from './patch-id.js';

export interface EnvelopeReviewScope {
  classification: ReviewScopeClassification;
  securityAlways: boolean;
  requiredSet: 'correctness-only' | 'full';
  appliedReviewers: string[];
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Classify `merge-base(baseRef, head)..head` and describe the applied reviewers.
 * Returns `undefined` when the repo or base ref is unavailable (nothing to
 * record). A listing failure after the merge-base resolved classifies as `full`.
 */
export function deriveEnvelopeReviewScope(
  repoRoot: string,
  headSha: string,
  reviewerNames: readonly string[],
  baseRef = 'origin/main',
): EnvelopeReviewScope | undefined {
  const mergeBase = git(['merge-base', baseRef, headSha], repoRoot)?.trim();
  if (!mergeBase || !/^[0-9a-f]{40}$/i.test(mergeBase)) return undefined;
  const listing = git(
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      `${mergeBase}..${headSha}`,
      '--',
      ...PATCH_ID_EXCLUSIONS,
    ],
    repoRoot,
  );
  const paths = listing === null ? [] : listing.split('\0').filter(Boolean);
  const { classification } = classifyReviewScope(paths);
  const securityAlways = parseSecurityReviewAlways(
    git(['show', `${baseRef}:.ai-sdlc/review-config.yaml`], repoRoot),
  );
  return {
    classification,
    securityAlways,
    requiredSet: reviewerSetKindFor(classification, { securityAlways }),
    appliedReviewers: [...reviewerNames],
  };
}
