/**
 * Approval tier classification based on complexity and sensitivity.
 */

import type { ApprovalTier } from './interfaces.js';

export interface ApprovalClassificationInput {
  complexityScore: number;
  securitySensitive?: boolean;
  isInfraChange?: boolean;
}

/**
 * Classify the required approval tier based on complexity score and flags.
 *
 * Score-based mapping:
 * - 1-3  -> auto
 * - 4-6  -> peer-review
 * - 7-8  -> team-lead
 * - 9-10 -> security-review
 *
 * Overrides:
 * - Infrastructure changes always require at least team-lead
 * - Security-sensitive changes always require security-review
 */
export function classifyApprovalTier(input: ApprovalClassificationInput): ApprovalTier {
  const { complexityScore, securitySensitive = false, isInfraChange = false } = input;

  if (securitySensitive) {
    return 'security-review';
  }

  let tier: ApprovalTier;
  if (complexityScore >= 9) {
    tier = 'security-review';
  } else if (complexityScore >= 7) {
    tier = 'team-lead';
  } else if (complexityScore >= 4) {
    tier = 'peer-review';
  } else {
    tier = 'auto';
  }

  // Infrastructure changes always require at least team-lead
  if (isInfraChange && (tier === 'auto' || tier === 'peer-review')) {
    tier = 'team-lead';
  }

  return tier;
}

const TIER_ORDER: Record<ApprovalTier, number> = {
  auto: 0,
  'peer-review': 1,
  'team-lead': 2,
  'security-review': 3,
};

/** Compare two tiers; returns positive if a > b, negative if a < b, 0 if equal. */
export function compareTiers(a: ApprovalTier, b: ApprovalTier): number {
  return TIER_ORDER[a] - TIER_ORDER[b];
}
