/**
 * Model selection logic — maps task complexity and budget pressure
 * to a specific model choice.
 *
 * Implements the modelSelection spec from agent-role.schema.json.
 */

import type { ModelSelection, ModelRule, BudgetPressureRule } from '../core/types.js';

export interface ModelSelectionContext {
  /** Task complexity score (0–1 range). */
  complexity: number;
  /** Current budget utilization as a 0–1 ratio. */
  budgetUtilization: number;
}

export interface ModelSelectionResult {
  model: string;
  reason: string;
  downshifted: boolean;
  notifyTargets?: string[];
}

/**
 * Select a model based on complexity rules and budget pressure.
 *
 * 1. Find the ModelRule whose complexity range contains the given score.
 * 2. Apply budget pressure: for each BudgetPressureRule where
 *    budgetUtilization > rule.above, accumulate downshift count.
 * 3. If downshifted, move to a lower-index (cheaper) rule.
 * 4. If no rule matches after downshift, use fallbackChain[0].
 * 5. Returns undefined if no rules and no fallback are configured.
 */
export function selectModel(
  selection: ModelSelection,
  ctx: ModelSelectionContext,
): ModelSelectionResult | undefined {
  const rules = selection.rules ?? [];
  if (rules.length === 0 && (!selection.fallbackChain || selection.fallbackChain.length === 0)) {
    return undefined;
  }

  // Sort rules by complexity min ascending (cheapest/simplest first)
  const sorted = [...rules].sort((a, b) => a.complexity[0] - b.complexity[0]);

  // Find the matching rule index
  let matchIndex = sorted.findIndex(
    (r) => ctx.complexity >= r.complexity[0] && ctx.complexity <= r.complexity[1],
  );

  // Calculate total downshift from budget pressure
  let totalDownshift = 0;
  const notifyTargets: string[] = [];
  if (selection.budgetPressure) {
    for (const pressure of selection.budgetPressure) {
      if (ctx.budgetUtilization > pressure.above) {
        totalDownshift += pressure.downshift;
        if (pressure.notify) {
          notifyTargets.push(...pressure.notify);
        }
      }
    }
  }

  const downshifted = totalDownshift > 0;

  // Apply downshift — move to a cheaper (lower-index) rule
  if (matchIndex >= 0 && totalDownshift > 0) {
    matchIndex = Math.max(0, matchIndex - totalDownshift);
  }

  // Return matched rule
  if (matchIndex >= 0) {
    const rule = sorted[matchIndex];
    return {
      model: rule.model,
      reason: downshifted
        ? `Downshifted from higher tier due to budget pressure (${(ctx.budgetUtilization * 100).toFixed(0)}% utilized)`
        : rule.rationale ?? `Complexity ${ctx.complexity} matched range [${rule.complexity[0]}, ${rule.complexity[1]}]`,
      downshifted,
      notifyTargets: notifyTargets.length > 0 ? notifyTargets : undefined,
    };
  }

  // No rule matched — use fallback chain
  if (selection.fallbackChain && selection.fallbackChain.length > 0) {
    return {
      model: selection.fallbackChain[0],
      reason: 'No complexity rule matched; using fallback',
      downshifted,
      notifyTargets: notifyTargets.length > 0 ? notifyTargets : undefined,
    };
  }

  return undefined;
}
