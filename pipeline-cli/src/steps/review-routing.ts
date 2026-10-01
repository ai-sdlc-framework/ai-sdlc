/**
 * Review routing (`review.routing`): after the set of reviewers is selected, ask the
 * judgment whether the diff touches a sensitive area the path rules missed, and add the
 * reviewers it calls for. Union only: the result always contains every reviewer that
 * came in, so it can never return a smaller set. It is applied after set selection, so
 * it can add reviewers back to the merged set.
 *
 * @module steps/review-routing
 */

import {
  evaluateJudgment,
  reviewRoutingDefinition,
  type EvaluateJudgmentContext,
  type RoutingReviewerName,
} from '@ai-sdlc/reference';
import {
  decideFromRulesetOutput,
  defaultRulesetDecision,
  type ReviewerName,
} from '../classifier/classifier.js';
import type { ReviewerType } from '../types.js';
import { judgmentLayerActive, reviewPaths } from './review-judgment-support.js';

const NAME_TO_TYPE: Record<RoutingReviewerName, ReviewerType> = {
  testing: 'test-reviewer',
  critic: 'code-reviewer',
  security: 'security-reviewer',
};

export interface RouteReviewersOpts {
  /** The reviewers selected so far. */
  reviewers: readonly ReviewerType[];
  changedFiles: readonly string[];
  diff: string;
  sourceKind?: string;
  taskId?: string;
  judgment?: EvaluateJudgmentContext;
}

export interface RouteReviewersResult {
  reviewers: ReviewerType[];
  /** Reviewers the judgment added to the incoming set. */
  added: ReviewerType[];
  /** Ids of the signals that decided. */
  signals: string[];
}

/** The reviewers the path classifier chooses for these paths. */
export function pathClassifierReviewers(paths: readonly string[]): ReviewerName[] {
  const decision = decideFromRulesetOutput(
    defaultRulesetDecision({
      filesChanged: paths.length,
      paths: [...paths],
      linesAdded: 0,
      linesRemoved: 0,
    }),
  );
  return [...decision.reviewers];
}

/** Apply `review.routing`. An abstain, a disabled layer or shadow mode returns the input set unchanged. */
export async function routeReviewers(opts: RouteReviewersOpts): Promise<RouteReviewersResult> {
  const unchanged: RouteReviewersResult = {
    reviewers: [...opts.reviewers],
    added: [],
    signals: [],
  };
  const ctx = opts.judgment;
  if (!ctx || !judgmentLayerActive(ctx)) return unchanged;

  const regexReviewers = pathClassifierReviewers(reviewPaths(opts.changedFiles, opts.diff));
  const outcome = await evaluateJudgment(
    reviewRoutingDefinition,
    { changedFiles: [...opts.changedFiles], diff: opts.diff, regexReviewers },
    {
      ...ctx,
      ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      incumbent: { reviewers: regexReviewers },
    },
  );
  if (outcome.kind !== 'act') return unchanged;

  const have = new Set<ReviewerType>(opts.reviewers);
  const added: ReviewerType[] = [];
  for (const name of outcome.decision.called) {
    const type = NAME_TO_TYPE[name];
    if (type && !have.has(type)) {
      have.add(type);
      added.push(type);
    }
  }
  return {
    reviewers: [...opts.reviewers, ...added],
    added,
    signals: outcome.decision.signals,
  };
}
