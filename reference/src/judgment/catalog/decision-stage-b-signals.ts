import type { JudgmentDefinition } from '../definition.js';
import { decisionState, scoreAnswer, thresholdOf, type DecisionText } from './common.js';

export interface ExemplarRef {
  id: string;
  /** Label the operator gave the exemplar, e.g. `true-positive` or `false-positive`. */
  label: string;
  summary: string;
  rationale?: string;
}

export interface StageBSignalsInput extends DecisionText {
  /** The exemplars relevant to this decision, selected by the caller. */
  exemplars: ReadonlyArray<ExemplarRef>;
}

export interface StageBSignals {
  /** Normalised 0..1; higher means more precedent in the history. */
  novelty: number;
  /** Normalised 0..1; higher means closer to an accepted exemplar. */
  exemplarSimilarity: number;
}

/** The value both signals held before this judgment existed. */
export const STAGE_B_SIGNAL_BASELINE = 0.5;

/** Minimum answer confidence before a signal leaves the baseline. */
export const STAGE_B_DEFAULT_MIN_CONFIDENCE = 0.5;

/** Level position divided by this gives the 0..1 value (four levels, positions 0..3). */
const LEVEL_DIVISOR = 3;

/**
 * Two scores in place of the constants 0.5: how much precedent the exemplar history holds
 * for this decision, and how close it is to the exemplars the operator accepted. Both are
 * oriented so a higher level means more confidence, matching the sign of their weights in
 * the confidence formula.
 *
 * reducesReview is declared false, and it holds only because compose never lifts a
 * signal above the 0.5 baseline: both signals feed the LLM-confidence rubric, and a
 * confidence of 0.7 or more with a reversible decision makes it eligible for the
 * framework to auto-decide without a person. Raising either signal to 1.0 can lift
 * confidence from 0.55 to 0.70 and flip that, which would be less review than the
 * constants give. So a level above the baseline is held at 0.5 and only levels that lower
 * confidence take effect. Lifting this cap makes the judgment review-reducing, which
 * needs riskClass 'relax' and its promotion bar.
 */
export const decisionStageBSignalsDefinition: JudgmentDefinition<
  StageBSignalsInput,
  StageBSignals
> = {
  id: 'decision.stage-b-signals',
  version: 1,
  egressClass: 'work-item-text',
  direction: 'bidirectional',
  riskClass: 'seam',
  fallback: 'pending',
  reducesReview: false,
  reducingOutcomes: [],
  capabilityId: 'decisions.stage-b-signals',
  buildState: (input) => ({
    decision: decisionState(input),
    exemplars: input.exemplars.map((e) => ({
      id: e.id,
      label: e.label,
      summary: e.summary,
      rationale: e.rationale ?? '',
    })),
  }),
  questions: () => ({
    novelty: {
      type: 'score',
      instructions:
        'How much precedent does the exemplar history hold for the decision in the state? ' +
        'Judge the kind of decision being made, not its wording.',
      levels: [
        'No exemplar concerns a decision of this kind: it is new ground.',
        'One or two exemplars touch the same area but ask a different question.',
        'An exemplar asks a similar question, with differences that could change the answer.',
        'The history settles a decision of this kind: an exemplar asks the same question in the same setting.',
      ],
    },
    exemplarSimilarity: {
      type: 'score',
      instructions:
        'How closely does the decision resemble the exemplars the operator accepted (true-positive, ' +
        'true-negative, borderline)? An exemplar the operator overrode (false-positive) counts as no similarity.',
      levels: [
        'It resembles no accepted exemplar, or only an overridden one.',
        'It loosely resembles an accepted exemplar in topic only.',
        'It resembles an accepted exemplar in topic and in the shape of the options.',
        'It closely matches an accepted exemplar: the same choice among the same kinds of options.',
      ],
    },
  }),
  compose(answers, _input, thresholds) {
    const novelty = scoreAnswer(answers, 'novelty');
    const similarity = scoreAnswer(answers, 'exemplarSimilarity');
    if (!novelty || !similarity) return { kind: 'abstain', reason: 'missing-answer' };
    const minConfidence = thresholdOf(thresholds, 'minConfidence', STAGE_B_DEFAULT_MIN_CONFIDENCE);
    const signal = (a: { score: number; confidence: number }): number => {
      if (a.confidence < minConfidence) return STAGE_B_SIGNAL_BASELINE;
      const v = Math.min(Math.max(a.score / LEVEL_DIVISOR, 0), 1);
      return Math.min(v, STAGE_B_SIGNAL_BASELINE);
    };
    return {
      kind: 'act',
      decision: { novelty: signal(novelty), exemplarSimilarity: signal(similarity) },
    };
  },
  agrees(decision, label) {
    if (typeof label !== 'object' || label === null) return false;
    const l = label as Partial<StageBSignals>;
    return l.novelty === decision.novelty && l.exemplarSimilarity === decision.exemplarSimilarity;
  },
};
