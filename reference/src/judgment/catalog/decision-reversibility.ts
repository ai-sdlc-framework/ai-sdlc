import type { JudgmentDefinition } from '../definition.js';
import { choiceAnswer, decisionState, thresholdOf, type DecisionText } from './common.js';

export type Reversibility = 'reversible' | 'one-way' | 'unknown';

const REVERSIBILITIES: readonly Reversibility[] = ['reversible', 'one-way', 'unknown'];

/** Minimum probability of the chosen option before the judgment acts. */
export const REVERSIBILITY_DEFAULT_THRESHOLD = 0.8;

/**
 * Is the decision reversible? Replaces the phrase list that decided reversibility by
 * substring match.
 *
 * reducesReview is declared false, and that is true for this judgment as wired:
 * - `one-way` and `unknown` only keep or add scrutiny.
 * - `reversible` is the one permissive outcome. On untrusted work (permissiveAllowed
 *   false) compose escalates instead of acting. On trusted work it acts, and the Stage A
 *   consumer then treats it as `unknown` for every gate: a reversible verdict is only
 *   recorded next to the result, because `reversible` is what lets Stage A and Stage B
 *   route a decision to the framework to auto-decide, which `unknown` does not. A phrase
 *   list `one-way` hit is also never overridden. So no outcome yields less review than
 *   the phrase list alone.
 *
 * Reversibility also feeds the Stage B loadBearing score, hence compositeScore, the Stage C
 * band and the framework route. A judged `one-way` raises loadBearing, and the composite is
 * not monotonic in review (a composite on either side of [0.4, 0.7) means less model
 * involvement), so no judged reversibility reaches a gate: every gating read uses the
 * baseline composite computed from the phrase list and explicit field alone, and the judged
 * composite is carried for display only (`judgedCompositeScore`).
 */
export const decisionReversibilityDefinition: JudgmentDefinition<DecisionText, Reversibility> = {
  id: 'decision.reversibility',
  version: 1,
  egressClass: 'work-item-text',
  direction: 'bidirectional',
  riskClass: 'seam',
  fallback: 'pending',
  reducesReview: false,
  reducingOutcomes: [],
  buildState: (input) => decisionState(input),
  questions: () => ({
    reversibility: {
      type: 'choice',
      instructions:
        'Decide whether the decision described in the state can be undone later at low cost. ' +
        'Consider the chosen option, not the discussion around it.',
      options: {
        reversible:
          'The chosen option can be changed or rolled back later with little cost and no lasting side effects.',
        'one-way':
          'Once chosen, undoing it is costly or impossible (published interfaces, data migrations, deletions, anything others will depend on).',
        unknown: 'None of these: the text does not say enough to tell.',
      },
    },
  }),
  compose(answers, _input, thresholds, ctx) {
    const a = choiceAnswer(answers, 'reversibility');
    if (!a || !REVERSIBILITIES.includes(a.choice as Reversibility)) {
      return { kind: 'abstain', reason: 'missing-answer' };
    }
    const p = a.probabilities[a.choice] ?? 0;
    if (p < thresholdOf(thresholds, 'reversibility', REVERSIBILITY_DEFAULT_THRESHOLD)) {
      return { kind: 'escalate', to: 'operator', reason: 'low-confidence' };
    }
    const choice = a.choice as Reversibility;
    if (choice === 'reversible' && !ctx.permissiveAllowed) {
      return { kind: 'escalate', to: 'operator', reason: 'reversible-not-permitted' };
    }
    return { kind: 'act', decision: choice };
  },
  agrees: (decision, label) => decision === label,
};
