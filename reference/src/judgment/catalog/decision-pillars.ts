import type { JudgmentDefinition } from '../definition.js';
import { decisionState, noulProbability, thresholdOf, type DecisionText } from './common.js';

export const DECISION_PILLARS = ['design', 'engineering', 'product'] as const;
export type DecisionPillar = (typeof DECISION_PILLARS)[number];

/** Minimum Noul probability for a pillar to count as affected. */
export const PILLAR_DEFAULT_THRESHOLD = 0.7;

const PILLAR_QUESTIONS: Record<DecisionPillar, string> = {
  engineering:
    'Does this decision change how software is built, structured, tested, deployed or operated?',
  product:
    'Does this decision change what the product does, who it is for, its scope or its priorities?',
  design:
    'Does this decision change how the product looks, feels or is interacted with by a person?',
};

/**
 * Which pillars does the decision affect? One Noul per pillar, several may apply.
 * Replaces substring keyword matching.
 *
 * reducesReview is declared false: the pillar set decides who must sign off, and more
 * pillars means more authority (a multi-pillar decision routes to the operator, a single
 * pillar to its owner). The consumer therefore only ever adds judged pillars to the
 * keyword result and never removes one, so no outcome yields less review. No outcome is
 * permissive, so the direction is nominal. An empty set abstains and the keyword result
 * stands.
 */
export const decisionPillarsDefinition: JudgmentDefinition<DecisionText, DecisionPillar[]> = {
  id: 'decision.pillars',
  version: 1,
  egressClass: 'work-item-text',
  direction: 'bidirectional',
  riskClass: 'seam',
  fallback: 'pending',
  reducesReview: false,
  reducingOutcomes: [],
  buildState: (input) => decisionState(input),
  questions: () =>
    Object.fromEntries(
      DECISION_PILLARS.map((p) => [
        p,
        { type: 'noul' as const, instructions: PILLAR_QUESTIONS[p] },
      ]),
    ),
  compose(answers, _input, thresholds) {
    const min = thresholdOf(thresholds, 'pillar', PILLAR_DEFAULT_THRESHOLD);
    const pillars: DecisionPillar[] = [];
    for (const p of DECISION_PILLARS) {
      const prob = noulProbability(answers, p);
      if (prob === undefined) return { kind: 'abstain', reason: 'missing-answer' };
      if (prob >= min) pillars.push(p);
    }
    if (pillars.length === 0) return { kind: 'abstain', reason: 'no-pillar-clears-threshold' };
    return { kind: 'act', decision: pillars };
  },
  agrees(decision, label) {
    if (!Array.isArray(label)) return false;
    const a = [...decision].sort().join('|');
    const b = label.map(String).sort().join('|');
    return a === b;
  },
};
