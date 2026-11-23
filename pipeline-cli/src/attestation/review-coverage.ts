/**
 * RFC-0061 goal 5: the ONE coverage rule.
 *
 * `computeRequiredReviewers` derives the reviewer set the review policy requires for the touched
 * paths. Step 8 (the writer) evaluates it once and copies the result into the verdict record's
 * `coverage`; the checker (AISDLC-1169) imports `computeRequiredReviewers` /
 * `evaluateCoverage` from this module and never recomputes by a different rule.
 *
 * @module attestation/review-coverage
 */

import { classifyReviewerSet } from '../steps/reviewer-set.js';

export interface RequiredReviewers {
  /** Policy reference the set was derived under (`review-policy@<ref>`). */
  policy: string;
  /** Reviewer names the policy requires for these paths. */
  required: string[];
  /** Why this set (`no-trust-chain-path`, or the reason three were required). */
  reason: string;
}

export interface CoverageInput {
  /** Paths the change touches; `null` when the diff could not be read (fails closed to three). */
  changedPaths: readonly string[] | null | undefined;
  requireThree?: boolean;
  /** Identifier of the policy version (for example the base sha); `builtin` when unversioned. */
  policyRef?: string;
}

/** The single rule: which reviewers must approve for this change. */
export function computeRequiredReviewers(input: CoverageInput): RequiredReviewers {
  const c = classifyReviewerSet({
    changedPaths: input.changedPaths,
    requireThree: input.requireThree,
  });
  return {
    policy: `review-policy@${input.policyRef ?? 'builtin'}`,
    required: [...c.reviewers],
    reason: c.reason,
  };
}

/** Where the review ran: the same-repo pipeline, or the untrusted-PR clean-room sandbox. */
export type ReviewOrigin = 'pipeline' | 'clean-room';

/**
 * AISDLC-1321: the required reviewers for a head, by where the review ran. A clean-room review
 * always runs the three UCVG reviewers, so its set is the three-reviewer set whatever the paths;
 * a pipeline head keeps the diff-derived set. The writer and the checker both call this.
 */
export function requiredReviewersFor(
  origin: ReviewOrigin,
  changedPaths: readonly string[] | null | undefined,
): RequiredReviewers {
  return computeRequiredReviewers({ changedPaths: origin === 'clean-room' ? null : changedPaths });
}

export interface Coverage {
  policy: string;
  required: string[];
  satisfied: boolean;
}

/** `satisfied` iff every required reviewer is among the approving reviewers. */
export function evaluateCoverage(
  required: RequiredReviewers,
  approvedReviewers: readonly string[],
): Coverage {
  const have = new Set(approvedReviewers);
  return {
    policy: required.policy,
    required: [...required.required],
    satisfied: required.required.every((r) => have.has(r)),
  };
}
