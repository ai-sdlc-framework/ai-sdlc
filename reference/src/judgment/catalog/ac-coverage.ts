import type { JudgmentDefinition } from '../definition.js';
import type { JudgmentQuestion } from '../types.js';

/** Default probability below which a criterion is flagged `likely-uncovered`. */
export const AC_COVERAGE_DEFAULT_THRESHOLD = 0.5;

export interface AcCoverageInput {
  /** The task's acceptance criteria, in order. */
  acceptanceCriteria: string[];
  /** The diff against the merge base (redacted by the runtime before sending). */
  diff: string;
}

export interface AcCoverageEntry {
  /** Index into `acceptanceCriteria`. */
  index: number;
  /** Probability that the diff contains a change addressing the criterion. */
  probability: number;
  likelyUncovered: boolean;
}

export interface AcCoverageDecision {
  criteria: AcCoverageEntry[];
  uncovered: number;
}

/** Question id for the criterion at `index`. */
export const acCoverageQuestionId = (index: number): string => `ac-${index}`;

/**
 * Advisory check: does the diff contain a change that addresses each acceptance
 * criterion? One Noul per criterion, all in one request. Tighten-only: a low
 * probability escalates to the operator, nothing is ever approved or dropped.
 */
export const acCoverageJudgment: JudgmentDefinition<AcCoverageInput, AcCoverageDecision> = {
  id: 'dev.ac-coverage',
  version: 1,
  egressClass: 'code-diff',
  direction: 'tighten-only',
  riskClass: 'tighten',
  buildState: (input) => ({
    acceptanceCriteria: [...input.acceptanceCriteria],
    diff: input.diff,
  }),
  questions: (input) => {
    const questions: Record<string, JudgmentQuestion> = {};
    input.acceptanceCriteria.forEach((_, i) => {
      questions[acCoverageQuestionId(i)] = {
        type: 'noul',
        instructions:
          `Does the diff contain a change that addresses the acceptance criterion at ` +
          `acceptanceCriteria[${i}]?`,
        criteria: {
          true: 'The diff contains a change that addresses the criterion.',
          false: 'No change in the diff addresses the criterion.',
        },
      };
    });
    return questions;
  },
  compose: (answers, input, thresholds) => {
    const threshold = thresholds.covered ?? AC_COVERAGE_DEFAULT_THRESHOLD;
    const criteria: AcCoverageEntry[] = input.acceptanceCriteria.map((_, index) => {
      const answer = answers[acCoverageQuestionId(index)];
      const probability = answer?.type === 'noul' ? answer.probability : 0;
      return { index, probability, likelyUncovered: probability < threshold };
    });
    const uncovered = criteria.filter((c) => c.likelyUncovered).length;
    const decision: AcCoverageDecision = { criteria, uncovered };
    if (uncovered === 0) return { kind: 'act', decision };
    return {
      kind: 'escalate',
      to: 'operator',
      reason: `${uncovered} of ${criteria.length} acceptance criteria look uncovered by the diff`,
      partial: decision,
    };
  },
};
