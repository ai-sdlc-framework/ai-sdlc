import { getJudgmentDefinition, registerJudgmentDefinition } from '../catalog.js';
import { reviewRoutingDefinition } from './review-routing.js';
import { reviewerSetDefinition } from './review-reviewer-set.js';

export * from './review-routing.js';
export * from './review-reviewer-set.js';

/** Register the review judgments. Safe to call more than once. */
export function registerReviewJudgmentDefinitions(): void {
  if (!getJudgmentDefinition(reviewRoutingDefinition.id)) {
    registerJudgmentDefinition(reviewRoutingDefinition);
  }
  if (!getJudgmentDefinition(reviewerSetDefinition.id)) {
    registerJudgmentDefinition(reviewerSetDefinition);
  }
}
