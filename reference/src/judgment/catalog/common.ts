import type { JudgmentAnswer } from '../types.js';

/** Default pass probability when a threshold set carries no value for a name. */
export function thresholdOf(
  thresholds: Record<string, number>,
  name: string,
  fallback: number,
): number {
  const v = thresholds[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** The choice answer for a question id, or undefined when absent or of another type. */
export function choiceAnswer(
  answers: Record<string, JudgmentAnswer>,
  id: string,
): Extract<JudgmentAnswer, { type: 'choice' }> | undefined {
  const a = answers[id];
  return a?.type === 'choice' ? a : undefined;
}

/** The Noul probability for a question id, or undefined when absent or of another type. */
export function noulProbability(
  answers: Record<string, JudgmentAnswer>,
  id: string,
): number | undefined {
  const a = answers[id];
  return a?.type === 'noul' ? a.probability : undefined;
}

/** The score answer for a question id, or undefined when absent or of another type. */
export function scoreAnswer(
  answers: Record<string, JudgmentAnswer>,
  id: string,
): Extract<JudgmentAnswer, { type: 'score' }> | undefined {
  const a = answers[id];
  return a?.type === 'score' ? a : undefined;
}

/** Work-item text common to the decision judgments. Only these fields are sent. */
export interface DecisionText {
  summary: string;
  body?: string;
  options?: ReadonlyArray<{ id: string; description: string }>;
}

/** The state fragment for one decision: summary, body and option descriptions only. */
export function decisionState(d: DecisionText): {
  summary: string;
  body: string;
  options: { id: string; description: string }[];
} {
  return {
    summary: d.summary,
    body: d.body ?? '',
    options: (d.options ?? []).map((o) => ({ id: o.id, description: o.description })),
  };
}
