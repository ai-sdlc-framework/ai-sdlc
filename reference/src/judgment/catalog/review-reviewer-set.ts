/**
 * `review.reviewer-set`: the one `relax`-class judgment. For one PR it may select the
 * merged two-reviewer set (correctness plus security) instead of three reviewers.
 *
 * Nouls ask, for each risk signal that argues for separate code and test review,
 * whether it applies. `compose` returns the merged set only when every signal is below
 * its threshold and the work is trusted (`permissiveAllowed`); otherwise it abstains and
 * the caller keeps the reviewer set it would have used without the judgment. A signal
 * with no configured threshold is never below it, so missing config never relaxes.
 */

import type { JudgmentDefinition, Thresholds } from '../definition.js';
import type { JsonValue, JudgmentAnswer, JudgmentQuestion } from '../types.js';

export const REVIEWER_SET_MERGED = 'code-test-merged' as const;

export interface ReviewerSetInput {
  /** Paths changed by the diff. */
  changedFiles: string[];
  /** Unified diff text. */
  diff: string;
}

export interface ReviewerSetDecision {
  set: typeof REVIEWER_SET_MERGED;
  /** Probability each risk signal received (all below their thresholds). */
  signals: Record<string, number>;
}

/** The label `agrees` reads: did a separate code or test reviewer find a blocking issue first pass. */
export interface ReviewerSetLabel {
  separateReviewBlocking: boolean;
}

const SIGNALS: readonly { id: string; instructions: string }[] = [
  {
    id: 'concurrency-persistence-state',
    instructions:
      'Does this change alter concurrency, persistence, caching or shared-state handling, where a subtle defect would need careful separate code review?',
  },
  {
    id: 'public-api-schema',
    instructions:
      'Does this change alter a public API, a wire format, a schema or another contract that other code depends on?',
  },
  {
    id: 'behaviour-without-tests',
    instructions:
      'Does this change alter runtime behaviour without a matching change to the tests that cover it?',
  },
  {
    id: 'multi-package',
    instructions:
      'Does this change span several packages or top-level modules, where separate review of code and tests would add coverage?',
  },
];

/** Ids of the risk signals, for callers that report them. */
export const REVIEWER_SET_SIGNAL_IDS: readonly string[] = SIGNALS.map((s) => s.id);

function isLabel(label: unknown): label is ReviewerSetLabel {
  return (
    typeof label === 'object' &&
    label !== null &&
    typeof (label as ReviewerSetLabel).separateReviewBlocking === 'boolean'
  );
}

export const reviewerSetDefinition: JudgmentDefinition<ReviewerSetInput, ReviewerSetDecision> = {
  id: 'review.reviewer-set',
  version: 1,
  egressClass: 'code-diff',
  direction: 'bidirectional',
  riskClass: 'relax',
  reducesReview: true,
  reducingOutcomes: [REVIEWER_SET_MERGED],
  buildState(input): JsonValue {
    return { changedFiles: input.changedFiles, diff: input.diff };
  },
  questions(): Record<string, JudgmentQuestion> {
    const out: Record<string, JudgmentQuestion> = {};
    for (const s of SIGNALS) out[s.id] = { type: 'noul', instructions: s.instructions };
    return out;
  },
  compose(answers: Record<string, JudgmentAnswer>, _input, thresholds: Thresholds, ctx) {
    if (!ctx.permissiveAllowed) return { kind: 'abstain', reason: 'permissive-not-allowed' };
    const signals: Record<string, number> = {};
    for (const s of SIGNALS) {
      const a = answers[s.id];
      if (!a || a.type !== 'noul') return { kind: 'abstain', reason: `missing-answer:${s.id}` };
      const threshold = thresholds[s.id];
      if (typeof threshold !== 'number') return { kind: 'abstain', reason: `no-threshold:${s.id}` };
      if (!(a.probability < threshold)) return { kind: 'abstain', reason: `signal-raised:${s.id}` };
      signals[s.id] = a.probability;
    }
    return { kind: 'act', decision: { set: REVIEWER_SET_MERGED, signals } };
  },
  agrees(decision, label) {
    if (!isLabel(label)) return false;
    return decision.set === REVIEWER_SET_MERGED ? !label.separateReviewBlocking : true;
  },
};
