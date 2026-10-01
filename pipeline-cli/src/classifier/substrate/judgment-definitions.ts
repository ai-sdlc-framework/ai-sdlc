/**
 * The five judgment definitions that give the classifier substrate a backend
 * (RFC-0049 section 5, Group A). Each maps one substrate task type to one
 * catalog definition. The option sets are built from the substrate's own
 * allowed-classification enums, never restated, and the pending sentinel is
 * never offered as an option.
 *
 * Declarations (see docs/operations/judgment-definitions.md): every definition is
 * `riskClass: 'seam'` and `direction: 'bidirectional'` with `fallback: 'pending'`,
 * `reducingOutcomes: []` and `reducesReview: false`. No outcome can reduce review:
 * the substrate returns `pending` (operator routing) on abstain or escalate, and a
 * permissive outcome escalates to the operator unless the work item is trusted.
 * Residual risk: the declaration is the author's attestation and the registry cannot
 * observe `compose`; reviewers must re-check `compose` against it whenever it changes.
 *
 * @module classifier/substrate/judgment-definitions
 */

import {
  getJudgmentDefinition,
  registerJudgmentDefinition,
  type ComposeContext,
  type JsonValue,
  type JudgmentAnswer,
  type JudgmentDefinition,
  type JudgmentOutcome,
  type JudgmentQuestion,
  type Thresholds,
} from '@ai-sdlc/reference';

import { ALLOWED_CLASSIFICATIONS } from './task-prompts.js';
import type { ClassifierInput, ClassifierTaskType } from './types.js';

/** The sentinel the substrate returns when it cannot classify. Never an option. */
export const PENDING_CLASSIFICATION = 'pending';

/** What a substrate judgment decides: the classification and the answer's confidence. */
export interface SubstrateJudgmentDecision {
  classification: string;
  confidence: number;
}

export type SubstrateJudgmentDefinition = JudgmentDefinition<
  ClassifierInput,
  SubstrateJudgmentDecision
>;

/** Judgment id for each substrate task type. */
export const SUBSTRATE_JUDGMENT_IDS: Readonly<Record<ClassifierTaskType, string>> = Object.freeze({
  'capture-triage': 'capture.triage',
  'capture-severity': 'capture.severity',
  'pr-comment-is-capture': 'capture.pr-comment',
  'dor-answer-is-new-concern': 'dor.answer-segment',
  'decision-recommendation': 'decision.recommendation',
});

/** Capability id each judgment serves. */
export const SUBSTRATE_CAPABILITY_IDS: Readonly<Record<ClassifierTaskType, string>> = Object.freeze(
  {
    'capture-triage': 'classifier.capture-triage',
    'capture-severity': 'classifier.capture-severity',
    'pr-comment-is-capture': 'classifier.pr-comment-is-capture',
    'dor-answer-is-new-concern': 'classifier.dor-answer-is-new-concern',
    'decision-recommendation': 'decisions.stage-c-recommendation',
  },
);

/** Threshold names the compose functions read from the judgment config. */
export const CONFIDENCE_THRESHOLD = 'confidence';
export const DISTANCE_THRESHOLD = 'distance';

const QUESTION_ID = 'answer';
const NONE_OF_THESE = 'none-of-these';

function validThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function escalate(reason: string): JudgmentOutcome<SubstrateJudgmentDecision> {
  return { kind: 'escalate', to: 'operator', reason };
}

/** The substrate's enum for a task type with the pending sentinel removed. */
function enumOptions(taskType: ClassifierTaskType): string[] {
  return ALLOWED_CLASSIFICATIONS[taskType].filter((v) => v !== PENDING_CLASSIFICATION);
}

function textState(input: ClassifierInput): JsonValue {
  return { text: input.text };
}

interface ChoiceSpec {
  taskType: ClassifierTaskType;
  instructions: string;
  optionDescriptions: Record<string, string>;
  /** Classifications that lean toward doing less; they escalate unless permitted. */
  permissive: readonly string[];
}

function choiceDefinition(spec: ChoiceSpec): SubstrateJudgmentDefinition {
  const permissive = new Set(spec.permissive);
  return {
    id: SUBSTRATE_JUDGMENT_IDS[spec.taskType],
    version: 1,
    egressClass: 'work-item-text',
    direction: 'bidirectional',
    riskClass: 'seam',
    fallback: 'pending',
    reducesReview: false,
    reducingOutcomes: [],
    capabilityId: SUBSTRATE_CAPABILITY_IDS[spec.taskType],
    buildState: textState,
    questions: () => ({
      [QUESTION_ID]: {
        type: 'choice',
        instructions: spec.instructions,
        options: Object.fromEntries(
          enumOptions(spec.taskType).map((v) => [v, spec.optionDescriptions[v] ?? v]),
        ),
      },
    }),
    compose: (answers, _input, thresholds, ctx) =>
      composeChoice(answers[QUESTION_ID], thresholds, ctx, permissive),
    agrees: (decision, label) => decision.classification === label,
  };
}

function composeChoice(
  answer: JudgmentAnswer | undefined,
  thresholds: Thresholds,
  ctx: ComposeContext<SubstrateJudgmentDecision>,
  permissive: ReadonlySet<string>,
): JudgmentOutcome<SubstrateJudgmentDecision> {
  if (!answer || answer.type !== 'choice') return escalate('malformed-answer');
  const threshold = thresholds[CONFIDENCE_THRESHOLD];
  if (!validThreshold(threshold)) return escalate('no-confidence-threshold');
  if (answer.confidence < threshold) return escalate('below-confidence-threshold');
  if (permissive.has(answer.choice) && !ctx.permissiveAllowed) {
    return escalate('permissive-outcome-needs-operator');
  }
  return {
    kind: 'act',
    decision: { classification: answer.choice, confidence: answer.confidence },
  };
}

const triage = choiceDefinition({
  taskType: 'capture-triage',
  instructions:
    'Choose the class that best describes what should happen to this captured finding. ' +
    'Pick tbd when it is genuinely ambiguous rather than guessing.',
  optionDescriptions: {
    'quick-fix-task':
      'A small, well-scoped change that fits in one pull request. Not a new capability and not a change to work already in flight.',
    'new-feature-issue':
      'A material new capability that needs its own issue and design. Not a small fix and not an extension of an existing task.',
    'scope-extension':
      'Extends the acceptance criteria of a task that is already in flight. Not a standalone item.',
    "won't-fix":
      'Out of scope or not worth addressing. Choose it only when the finding clearly needs no action; doubtful cases belong in tbd.',
    tbd: 'Genuinely ambiguous; an operator should decide. Not a weak guess at another class.',
  },
  permissive: ["won't-fix"],
});

const severity = choiceDefinition({
  taskType: 'capture-severity',
  instructions: 'Choose the severity of the risk this captured finding describes.',
  optionDescriptions: {
    low: 'Nice to have; no real risk if left alone. Not something that degrades behaviour for users.',
    medium:
      'Should be fixed soon but does not block work or users. Not an outage or security risk.',
    high: 'Meaningful risk if it is not addressed: wrong results, a blocked workflow, or a likely future incident.',
    critical:
      'Outage, security exposure or data loss risk. Reserve for findings that need action now.',
  },
  permissive: ['low'],
});

const answerSegment = choiceDefinition({
  taskType: 'dor-answer-is-new-concern',
  instructions:
    'Decide whether this segment of an operator answer only answers the question that was asked, ' +
    'or raises a separate concern.',
  optionDescriptions: {
    clarification:
      'Answers the question that was asked and raises nothing else. Not a new problem or follow-up.',
    'new-concern':
      'Raises something the question did not ask about, such as a risk, a missing requirement or a follow-up.',
    ambiguous:
      'Could be either; an operator should confirm. Not a weak guess at clarification or new-concern.',
  },
  // A clarification means "nothing to track", the answer-segment equivalent of not-a-capture.
  permissive: ['clarification'],
});

const prComment: SubstrateJudgmentDefinition = {
  id: SUBSTRATE_JUDGMENT_IDS['pr-comment-is-capture'],
  version: 1,
  egressClass: 'work-item-text',
  direction: 'bidirectional',
  riskClass: 'seam',
  fallback: 'pending',
  reducesReview: false,
  reducingOutcomes: [],
  capabilityId: SUBSTRATE_CAPABILITY_IDS['pr-comment-is-capture'],
  buildState: textState,
  questions: () => ({
    [QUESTION_ID]: {
      type: 'noul',
      instructions:
        'Is this review comment reporting a problem or follow-up that should be tracked beyond this pull request?',
      criteria: {
        true: 'The comment describes a concern that outlives the pull request: an architectural concern, a follow-up task, a design or scope question, or a future risk.',
        false:
          'The comment is only about this change: a typo, a style nit, a rename, or a request the author will simply do.',
      },
    },
  }),
  compose: (answers, _input, thresholds, ctx) => {
    const answer = answers[QUESTION_ID];
    if (!answer || answer.type !== 'noul') return escalate('malformed-answer');
    const threshold = thresholds[DISTANCE_THRESHOLD];
    if (!validThreshold(threshold)) return escalate('no-distance-threshold');
    const p = answer.probability;
    if (Math.abs(p - 0.5) < threshold) return escalate('below-distance-threshold');
    const isCapture = p > 0.5;
    if (!isCapture && !ctx.permissiveAllowed) return escalate('permissive-outcome-needs-operator');
    return {
      kind: 'act',
      decision: {
        classification: isCapture ? 'is-capture' : 'not-capture',
        confidence: isCapture ? p : 1 - p,
      },
    };
  },
  agrees: (decision, label) => decision.classification === label,
};

/** Option ids from the caller's context, as the substrate reads them. */
function contextOptionIds(input: ClassifierInput): string[] {
  const raw = input.context?.optionIds;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

function contextOptionDescriptions(input: ClassifierInput): Record<string, string> {
  const raw = input.context?.optionDescriptions;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    ),
  );
}

/** The none-of-these key, made distinct from every caller option id. */
function noneKey(ids: readonly string[]): string {
  let key = NONE_OF_THESE;
  while (ids.includes(key)) key = `_${key}`;
  return key;
}

const recommendation: SubstrateJudgmentDefinition = {
  id: SUBSTRATE_JUDGMENT_IDS['decision-recommendation'],
  version: 1,
  egressClass: 'work-item-text',
  direction: 'bidirectional',
  riskClass: 'seam',
  fallback: 'pending',
  reducesReview: false,
  reducingOutcomes: [],
  capabilityId: SUBSTRATE_CAPABILITY_IDS['decision-recommendation'],
  buildState: (input) => ({
    summary: input.text,
    options: contextOptionIds(input).map((id) => ({
      id,
      description: contextOptionDescriptions(input)[id] ?? '',
    })),
  }),
  questions: (input) => {
    const ids = contextOptionIds(input);
    const descriptions = contextOptionDescriptions(input);
    const options: Record<string, string> = {};
    for (const id of ids) options[id] = descriptions[id] ?? id;
    options[noneKey(ids)] =
      'None of the listed options fits. Choose this when the options do not cover the decision.';
    const q: JudgmentQuestion = {
      type: 'choice',
      instructions:
        'Choose the option you would recommend for this decision. The operator makes the final call.',
      options,
    };
    return { [QUESTION_ID]: q };
  },
  compose: (answers, input, thresholds, ctx) => {
    const answer = answers[QUESTION_ID];
    if (!answer || answer.type !== 'choice') return escalate('malformed-answer');
    const ids = contextOptionIds(input);
    if (answer.choice === noneKey(ids)) return escalate('none-of-these');
    if (!ids.includes(answer.choice)) return escalate('unknown-option');
    const threshold = thresholds[CONFIDENCE_THRESHOLD];
    if (!validThreshold(threshold)) return escalate('no-confidence-threshold');
    if (answer.confidence < threshold) return escalate('below-confidence-threshold');
    // Every recommendation is a permissive outcome: it is acted on only for trusted work.
    if (!ctx.permissiveAllowed) return escalate('permissive-outcome-needs-operator');
    return {
      kind: 'act',
      decision: { classification: answer.choice, confidence: answer.confidence },
    };
  },
  agrees: (decision, label) => decision.classification === label,
};

/** The five definitions, in registration order. */
export function substrateJudgmentDefinitions(): SubstrateJudgmentDefinition[] {
  return [triage, severity, prComment, answerSegment, recommendation];
}

/** The definition for a task type. */
export function substrateJudgmentDefinition(
  taskType: ClassifierTaskType,
): SubstrateJudgmentDefinition {
  const id = SUBSTRATE_JUDGMENT_IDS[taskType];
  const def = substrateJudgmentDefinitions().find((d) => d.id === id);
  if (!def) throw new Error(`no judgment definition for task type '${taskType}'`);
  return def;
}

/** Register the five definitions in the judgment catalog. Idempotent. */
export function registerSubstrateJudgments(): void {
  for (const def of substrateJudgmentDefinitions()) {
    if (!getJudgmentDefinition(def.id)) registerJudgmentDefinition(def);
  }
}
