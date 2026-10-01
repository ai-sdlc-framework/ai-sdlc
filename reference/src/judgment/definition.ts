import type { JsonValue, JudgmentAnswer, JudgmentQuestion } from './types.js';

/** Data classes a judgment may send to a provider. */
export type EgressClass = 'work-item-text' | 'code-diff' | 'agent-output';

export const EGRESS_CLASSES: readonly EgressClass[] = [
  'work-item-text',
  'code-diff',
  'agent-output',
];

/** `tighten-only` may only add scrutiny; `bidirectional` may also decide permissively. */
export type JudgmentDirection = 'tighten-only' | 'bidirectional';

/** Selects the promotion bar: seam, tighten or relax. */
export type JudgmentRiskClass = 'seam' | 'tighten' | 'relax';

/** Thresholds in force for the active provider@model, e.g. `{ pass: 0.85, fail: 0.15 }`. */
export type Thresholds = Record<string, number>;

export interface ComposeContext<D = unknown> {
  /** False means never decide in the permissive direction (escalate instead). */
  permissiveAllowed: boolean;
  /** Optional comparison used by evaluation tooling. */
  agrees?: (decision: D, label: unknown) => boolean;
  /** Capability this judgment serves, when it names one. */
  capabilityId?: string;
}

export type JudgmentOutcome<D> =
  | { kind: 'act'; decision: D }
  | { kind: 'escalate'; to: 'llm' | 'operator'; reason: string; partial?: Partial<D> }
  | { kind: 'abstain'; reason: string };

export interface JudgmentDefinition<I, D> {
  /** Stable id, e.g. 'dor.stage-b'. */
  id: string;
  /** Bump on any change to questions or composition. */
  version: number;
  egressClass: EgressClass;
  direction: JudgmentDirection;
  riskClass: JudgmentRiskClass;
  /** Name of the capability this judgment serves. */
  capabilityId?: string;
  /** Pure: selects only the fields the questions need. Must not truncate. */
  buildState(input: I): JsonValue;
  questions(input: I): Record<string, JudgmentQuestion>;
  /** Pure: the same answers and thresholds always yield the same outcome. */
  compose(
    answers: Record<string, JudgmentAnswer>,
    input: I,
    thresholds: Thresholds,
    ctx: ComposeContext<D>,
  ): JudgmentOutcome<D>;
  /** Used by evaluation tooling to compare a decision with a label. */
  agrees?(decision: D, label: unknown): boolean;
}
