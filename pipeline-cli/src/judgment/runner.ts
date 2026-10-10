/**
 * The seam between the pipeline's heuristics and the judgment layer.
 *
 * A consumer asks a `JudgmentRunner` to evaluate one definition and gets the outcome
 * back. `createJudgmentRunner` returns `undefined` when the layer is not configured, and
 * every consumer treats an absent runner (or any outcome other than `act`) as "do what
 * you did before", so default behaviour is unchanged and no network is touched.
 */

import {
  evaluateJudgment,
  type JudgmentDefinition,
  type JudgmentOutcome,
} from '@ai-sdlc/reference';
import { buildJudgmentContext, type BuildJudgmentContextOptions } from './context.js';

export interface JudgmentRunOptions {
  /** What the existing heuristic decided; recorded so agreement can be computed. */
  incumbent?: unknown;
  /** Kind of the work item. Only `'backlog'` may decide in the permissive direction. */
  sourceKind?: string;
  taskId?: string;
}

/** Evaluate one definition. Never throws; anything but `act` means keep the heuristic. */
export type JudgmentRunner = <I, D>(
  definition: JudgmentDefinition<I, D>,
  input: I,
  opts?: JudgmentRunOptions,
) => Promise<JudgmentOutcome<D>>;

/**
 * A runner for the configured provider, or `undefined` when the layer is disabled (no
 * config, or `AI_SDLC_JUDGMENT=off`). Capability outcomes are reported alongside the
 * judgment log.
 */
export function createJudgmentRunner(
  opts: BuildJudgmentContextOptions = {},
): JudgmentRunner | undefined {
  const ctx = buildJudgmentContext(opts);
  if (!ctx.config.provider) return undefined;
  return (definition, input, run = {}) =>
    evaluateJudgment(definition, input, {
      ...ctx,
      ...(run.incumbent !== undefined ? { incumbent: run.incumbent } : {}),
      ...(run.sourceKind ? { sourceKind: run.sourceKind } : {}),
      ...(run.taskId ? { taskId: run.taskId } : {}),
    });
}
