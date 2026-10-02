/**
 * The baseline / judged boundary for Stage A and Stage B.
 *
 * The Stage B composite is not monotonic in review: Stage C fires only inside [0.4, 0.7),
 * and either side of the band means less model involvement (and Stage C may auto-apply).
 * So nothing a judgment layer contributes may reach a gate. Gates accept only the branded
 * baseline types below, and the brand is applied only by `runBaselineStageA` /
 * `runBaselineStageB`. This module is deliberately NOT re-exported from the package index,
 * so `brandBaseline` is not part of the public surface.
 *
 * @module decisions/baseline-brand
 */

import type { StageAOutput, StageBOutput } from './decision-record.js';

declare const baselineBrand: unique symbol;

/**
 * Stage A output computed from NO judged input (no judged reversibility, pillars or
 * duplicate). The brand is a type-level boundary, only produced by `runBaselineStageA`.
 */
export type BaselineStageAOutput = StageAOutput & { readonly [baselineBrand]: true };

/**
 * Stage B output computed from a baseline Stage A and no judged signals. Every gate (the
 * Stage C band test, the Stage C auto-apply inputs, the framework route) accepts only this
 * type, which only `runBaselineStageB` produces. The composite is not monotonic in review
 * (Stage C fires only inside [0.4, 0.7), and either side of the band means less model
 * involvement), so a judged composite must never be handed to a gate.
 */
export type BaselineStageBOutput = StageBOutput & { readonly [baselineBrand]: true };

/** Apply a baseline brand. Reserved for `runBaselineStageA` and `runBaselineStageB`. */
export function brandBaseline<T extends StageAOutput | StageBOutput>(
  output: T,
): T & { readonly [baselineBrand]: true } {
  return output as T & { readonly [baselineBrand]: true };
}
