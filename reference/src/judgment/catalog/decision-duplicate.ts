import type { JudgmentDefinition } from '../definition.js';
import type { JudgmentQuestion } from '../types.js';
import { noulProbability, thresholdOf } from './common.js';

export interface DuplicateCandidate {
  id: string;
  summary: string;
}

export interface DuplicateInput {
  summary: string;
  body?: string;
  /** The edit-distance shortlist. Never empty when this judgment is asked. */
  candidates: ReadonlyArray<DuplicateCandidate>;
}

export interface DuplicateDecision {
  /** Id of the candidate the decision duplicates, or null when none is judged a duplicate. */
  duplicateOf: string | null;
}

/** Minimum Noul probability for a pair to count as a duplicate. */
export const DUPLICATE_DEFAULT_THRESHOLD = 0.9;

/** Question id for a candidate; ids are map keys on the wire. */
export function duplicateQuestionId(candidateId: string): string {
  return `dup-${candidateId}`;
}

/**
 * Do two decision summaries describe the same decision? One Noul per shortlisted pair,
 * all pairs in one request.
 *
 * reducesReview is declared false:
 * - In the Decision pipeline a declared duplicate removes the decision from the
 *   Stage A resolved set (`isResolvedByStageA` requires `!isDuplicate`), so a duplicate
 *   verdict only adds a hop. Nothing closes, suppresses or merges a decision.
 * - A verdict of "not a duplicate" cannot clear an edit-distance duplicate: the consumer
 *   keeps the keyword result when it already flagged one.
 * - The declared duplicate is still the permissive outcome, so compose escalates
 *   instead of acting when permissiveAllowed is false (untrusted work).
 */
export const decisionDuplicateDefinition: JudgmentDefinition<DuplicateInput, DuplicateDecision> = {
  id: 'decision.duplicate',
  version: 1,
  egressClass: 'work-item-text',
  direction: 'bidirectional',
  riskClass: 'seam',
  fallback: 'pending',
  reducesReview: false,
  reducingOutcomes: [],
  buildState: (input) => ({
    decision: { summary: input.summary, body: input.body ?? '' },
    candidates: input.candidates.map((c) => ({ id: c.id, summary: c.summary })),
  }),
  questions(input) {
    const qs: Record<string, JudgmentQuestion> = {};
    for (const c of input.candidates) {
      qs[duplicateQuestionId(c.id)] = {
        type: 'noul',
        instructions:
          `Compare the decision in the state with candidate ${c.id}. Do the two summaries ` +
          'describe the same decision to be made, so that answering one would settle the other?',
      };
    }
    return qs;
  },
  compose(answers, input, thresholds, ctx) {
    const min = thresholdOf(thresholds, 'duplicate', DUPLICATE_DEFAULT_THRESHOLD);
    let best: { id: string; p: number } | undefined;
    for (const c of input.candidates) {
      const p = noulProbability(answers, duplicateQuestionId(c.id));
      if (p === undefined) return { kind: 'abstain', reason: 'missing-answer' };
      if (p >= min && (!best || p > best.p)) best = { id: c.id, p };
    }
    if (!best) return { kind: 'act', decision: { duplicateOf: null } };
    if (!ctx.permissiveAllowed) {
      return { kind: 'escalate', to: 'operator', reason: 'duplicate-not-permitted' };
    }
    return { kind: 'act', decision: { duplicateOf: best.id } };
  },
  agrees(decision, label) {
    if (label === null || label === undefined || label === false)
      return decision.duplicateOf === null;
    return typeof label === 'string' && decision.duplicateOf === label;
  },
};
