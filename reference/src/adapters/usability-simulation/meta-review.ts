/**
 * Meta-review for medium-confidence usability findings (RFC-0006 §A.5.4).
 *
 * Findings below 0.5 are suppressed. Medium-confidence (0.5-0.8) go
 * through a lightweight verification pass.
 */

import type { UsabilityFinding, UsabilityMetaReview } from '../interfaces.js';

export const CONFIDENCE_THRESHOLD = 0.5;
export const META_REVIEW_UPPER = 0.8;

/**
 * Filter findings by confidence threshold.
 * Findings below 0.5 are suppressed.
 */
export function filterByConfidence(findings: UsabilityFinding[]): {
  kept: UsabilityFinding[];
  suppressed: UsabilityFinding[];
  needsMetaReview: UsabilityFinding[];
} {
  const kept: UsabilityFinding[] = [];
  const suppressed: UsabilityFinding[] = [];
  const needsMetaReview: UsabilityFinding[] = [];

  for (const f of findings) {
    if (f.confidence < CONFIDENCE_THRESHOLD) {
      suppressed.push(f);
    } else if (f.confidence < META_REVIEW_UPPER) {
      needsMetaReview.push(f);
    } else {
      kept.push(f);
    }
  }

  return { kept, suppressed, needsMetaReview };
}

/** Injectable meta-review evaluator (LLM call in production). */
export interface MetaReviewEvaluator {
  evaluate(finding: UsabilityFinding): Promise<UsabilityMetaReview>;
}

/**
 * Default meta-review evaluator: uses heuristics based on evidence quality.
 * In production, this would be replaced by a lightweight LLM call.
 */
export function createHeuristicMetaReviewer(): MetaReviewEvaluator {
  return {
    async evaluate(finding) {
      // Heuristic: keep findings with strong evidence, suppress weak ones
      const hasFailurePoint = !!finding.evidence.failurePoint;
      const hasScenario = finding.evidence.failureScenario.length > 20;
      const highActionDelta =
        finding.evidence.actionsTaken > finding.evidence.expectedActions * 1.5;

      if (hasFailurePoint && hasScenario) {
        return {
          finding,
          decision: 'keep',
          rationale: 'Finding has specific failure point and detailed scenario',
        };
      }

      if (highActionDelta && hasScenario) {
        return {
          finding,
          decision: 'keep',
          adjustedSeverity: 'minor',
          rationale: 'Significant action delta with scenario, downgraded to minor',
        };
      }

      return {
        finding,
        decision: 'suppress',
        rationale: 'Insufficient evidence for medium-confidence finding',
      };
    },
  };
}

/**
 * Run meta-review on medium-confidence findings.
 */
export async function runMetaReview(
  findings: UsabilityFinding[],
  evaluator: MetaReviewEvaluator,
): Promise<{
  kept: UsabilityFinding[];
  suppressed: UsabilityFinding[];
  reviews: UsabilityMetaReview[];
}> {
  const reviews: UsabilityMetaReview[] = [];
  const kept: UsabilityFinding[] = [];
  const suppressed: UsabilityFinding[] = [];

  for (const finding of findings) {
    const review = await evaluator.evaluate(finding);
    reviews.push(review);

    if (review.decision === 'keep') {
      const adjusted = review.adjustedSeverity
        ? { ...finding, severity: review.adjustedSeverity }
        : finding;
      kept.push(adjusted);
    } else {
      suppressed.push(finding);
    }
  }

  return { kept, suppressed, reviews };
}
