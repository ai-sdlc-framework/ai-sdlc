import type { JudgmentDefinition } from '../definition.js';
import { choiceAnswer, thresholdOf } from './common.js';

export type EstimateClass = 'bug' | 'feature' | 'chore' | 'uncategorized';

const CLASSES: readonly EstimateClass[] = ['bug', 'feature', 'chore', 'uncategorized'];

export interface EstimateClassInput {
  title: string;
  description?: string;
}

/** Minimum probability of the chosen class before the judgment acts. */
export const ESTIMATE_CLASS_DEFAULT_THRESHOLD = 0.7;

/**
 * What kind of work is the task: bug, feature or chore? Replaces the title-prefix regex.
 *
 * reducesReview is declared false. The class selects the seed bucket and the history the
 * effort estimate reads (an estimate shown in the pull request comment, logged and used
 * for calibration). Nothing in the review pipeline, no gate and no reviewer selection
 * reads the estimate class, and the estimate bucket does not gate a review either. So no
 * outcome yields less review. No outcome is permissive, so the direction is nominal. An
 * `uncategorized` answer abstains, so the regex result still stands: that class is kept
 * out of calibration and was never produced by the heuristic. Re-check this if a consumer
 * ever gates review on the estimate bucket.
 */
export const estimateClassDefinition: JudgmentDefinition<EstimateClassInput, EstimateClass> = {
  id: 'estimate.class',
  version: 1,
  egressClass: 'work-item-text',
  direction: 'bidirectional',
  riskClass: 'seam',
  fallback: 'pending',
  reducesReview: false,
  reducingOutcomes: [],
  capabilityId: 'estimation.class-assignment',
  buildState: (input) => ({ title: input.title, description: input.description ?? '' }),
  questions: () => ({
    class: {
      type: 'choice',
      instructions: 'Classify the task in the state by the kind of change it asks for.',
      options: {
        bug: 'Something that should work does not, and the task makes it work as intended.',
        feature: 'The task adds or extends behaviour that users or other code can rely on.',
        chore:
          'Maintenance with no new behaviour: refactoring, tests, docs, dependency or tooling upkeep.',
        uncategorized: 'None of these: the text does not say enough to tell.',
      },
    },
  }),
  compose(answers, _input, thresholds) {
    const a = choiceAnswer(answers, 'class');
    if (!a || !CLASSES.includes(a.choice as EstimateClass)) {
      return { kind: 'abstain', reason: 'missing-answer' };
    }
    if (a.choice === 'uncategorized') return { kind: 'abstain', reason: 'judged-uncategorized' };
    const p = a.probabilities[a.choice] ?? 0;
    if (p < thresholdOf(thresholds, 'class', ESTIMATE_CLASS_DEFAULT_THRESHOLD)) {
      return { kind: 'escalate', to: 'operator', reason: 'low-confidence' };
    }
    return { kind: 'act', decision: a.choice as EstimateClass };
  },
  agrees: (decision, label) => decision === label,
};
