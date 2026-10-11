/**
 * Signer-side review-scope record (AISDLC-723).
 *
 * Derives the diff classification, the reviewer kind it requires and the
 * reviewers that applied, so the
 * envelope can RECORD them. The record is informational: the CI verifier
 * (`verify-core.mjs` `enforceReviewScope`) re-derives the classification from
 * the diff and never reads this field, so a signer cannot assert a class.
 *
 * @module attestation/review-scope
 */

import { execFileSync } from 'node:child_process';
import {
  isPathMissingGitError,
  parseReviewerSetConfig,
  parseSecurityReviewAlways,
  requiredReviewerKind,
  type ReviewScopeClassification,
  type ReviewerKind,
} from '../../attestation-core/review-scope-core.mjs';
import { PATCH_ID_EXCLUSIONS } from './patch-id.js';

export interface EnvelopeReviewScope {
  classification: ReviewScopeClassification;
  securityAlways: boolean;
  /** The reviewer kind the diff requires (AISDLC-722 adds `two` and `three`). */
  requiredSet: ReviewerKind;
  /** Why the diff classified as it did (path or rule). */
  reason: string;
  /** Trust-chain paths that forced the three-reviewer set. */
  triggeringPaths: string[];
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
 * Read the base-branch review config. Returns `''` when the file is definitely
 * absent, the text when present, and `null` on any other git error (the caller
 * then fails closed to `securityAlways = true`).
 */
function readBaseReviewConfig(baseRef: string, cwd: string): string | null {
  try {
    return execFileSync('git', ['show', `${baseRef}:.ai-sdlc/review-config.yaml`], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return isPathMissingGitError(err) ? '' : null;
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
  const paths = listing === null ? null : listing.split('\0').filter(Boolean);
  const baseConfig = readBaseReviewConfig(baseRef, repoRoot);
  const securityAlways = baseConfig === null ? true : parseSecurityReviewAlways(baseConfig);
  // A config that cannot be read fails closed to three, like securityAlways.
  const requireThree = baseConfig === null || parseReviewerSetConfig(baseConfig) === 'three';
  const { kind, classification, reason, triggeringPaths } = requiredReviewerKind(paths, {
    securityAlways,
    requireThree,
  });
  return {
    classification,
    securityAlways,
    requiredSet: kind,
    reason,
    triggeringPaths: triggeringPaths.slice(0, 20),
    appliedReviewers: [...reviewerNames],
  };
}
