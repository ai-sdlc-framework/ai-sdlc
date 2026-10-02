/**
 * `review.routing`: after the path classifier decides which reviewers run, Nouls ask
 * whether the diff touches a sensitive area the path rules did not flag. The result is
 * the union of the path decision and any reviewer a Noul above its threshold calls for.
 * It can only add scrutiny: it never removes a reviewer the path rules chose.
 */

import type { JudgmentDefinition, Thresholds } from '../definition.js';
import type { JsonValue, JudgmentAnswer, JudgmentQuestion } from '../types.js';

/** Reviewer names used by the path classifier. */
export type RoutingReviewerName = 'testing' | 'critic' | 'security';

const CANONICAL_ORDER: readonly RoutingReviewerName[] = ['testing', 'critic', 'security'];

/** Used when a signal has no configured threshold. */
export const REVIEW_ROUTING_DEFAULT_THRESHOLD = 0.5;

export interface ReviewRoutingInput {
  /** Paths changed by the diff. */
  changedFiles: string[];
  /** Unified diff text. */
  diff: string;
  /** The reviewers the path classifier already chose. */
  regexReviewers: readonly RoutingReviewerName[];
}

export interface ReviewRoutingDecision {
  /** Union of the path decision and the added reviewers, in a stable order. */
  reviewers: RoutingReviewerName[];
  /** Reviewers beyond the path decision. */
  added: RoutingReviewerName[];
  /** Every reviewer the signals above threshold call for, whether or not the path decision had it. */
  called: RoutingReviewerName[];
  /** Ids of the signals that cleared their threshold. */
  signals: string[];
}

interface Signal {
  id: string;
  instructions: string;
  reviewers: readonly RoutingReviewerName[];
}

const SIGNALS: readonly Signal[] = [
  {
    id: 'auth-session-secrets',
    instructions:
      'Does this change alter authentication, authorisation, session handling or the handling of secrets or credentials?',
    reviewers: ['testing', 'critic', 'security'],
  },
  {
    id: 'input-handling',
    instructions:
      'Does this change alter input validation, deserialisation or parsing of untrusted data, shell command construction, or file-path handling?',
    reviewers: ['testing', 'security'],
  },
  {
    id: 'dependencies-ci',
    instructions:
      'Does this change alter dependency manifests, lockfiles, build or release scripts, or CI behaviour?',
    reviewers: ['critic', 'security'],
  },
];

function orderedUnion(
  ...lists: readonly (readonly RoutingReviewerName[])[]
): RoutingReviewerName[] {
  const set = new Set<RoutingReviewerName>(lists.flat());
  return CANONICAL_ORDER.filter((r) => set.has(r));
}

export const reviewRoutingDefinition: JudgmentDefinition<
  ReviewRoutingInput,
  ReviewRoutingDecision
> = {
  id: 'review.routing',
  version: 1,
  egressClass: 'code-diff',
  direction: 'tighten-only',
  riskClass: 'tighten',
  buildState(input): JsonValue {
    return { changedFiles: input.changedFiles, diff: input.diff };
  },
  questions(): Record<string, JudgmentQuestion> {
    const out: Record<string, JudgmentQuestion> = {};
    for (const s of SIGNALS) out[s.id] = { type: 'noul', instructions: s.instructions };
    return out;
  },
  compose(answers: Record<string, JudgmentAnswer>, input, thresholds: Thresholds) {
    const regex = input?.regexReviewers ?? [];
    const fired: Signal[] = [];
    for (const s of SIGNALS) {
      const a = answers[s.id];
      if (!a || a.type !== 'noul') continue;
      const threshold = thresholds[s.id] ?? REVIEW_ROUTING_DEFAULT_THRESHOLD;
      if (a.probability >= threshold) fired.push(s);
    }
    if (fired.length === 0) return { kind: 'abstain', reason: 'no-signal-above-threshold' };
    const called = orderedUnion(...fired.map((s) => s.reviewers));
    const reviewers = orderedUnion(regex, called);
    const regexSet = new Set(regex);
    return {
      kind: 'act',
      decision: {
        reviewers,
        added: reviewers.filter((r) => !regexSet.has(r)),
        called,
        signals: fired.map((s) => s.id),
      },
    };
  },
};
