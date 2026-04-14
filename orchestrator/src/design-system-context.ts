/**
 * Context strategy selection for design-system-aware agents (RFC-0006 §7.2).
 *
 * Implements the 5-step decision tree that determines how much design
 * system context an agent receives.
 */

import type { ContextStrategy, DesignSystemBinding } from '@ai-sdlc/reference';

export interface TaskContext {
  /** The trigger event type (e.g., 'design-token.changed', 'issue.assigned'). */
  triggerEvent?: string;
  /** Whether the task involves modifying existing components. */
  modifiesComponents?: boolean;
  /** Whether the task creates a new component. */
  createsNewComponent?: boolean;
  /** Whether the task involves both tokens AND component composition. */
  touchesTokensAndComponents?: boolean;
  /** Reusability score from the design-context stage (0.0-1.0). */
  reusabilityScore?: number;
}

export interface ContextStrategyResult {
  strategy: ContextStrategy;
  reason: string;
}

/**
 * Select the context strategy using the 5-step decision tree from RFC-0006 §7.2.
 *
 * 1. Token-change trigger with no component mods → tokens-only
 * 2. Modifying/composing existing components → manifest-first
 * 3. Creating new component → full
 * 4. Both tokens AND composition → full
 * 5. Reusability score < 0.5 → full
 *
 * Falls back to manifest-first as the default.
 */
export function selectContextStrategy(
  task: TaskContext,
  binding: DesignSystemBinding,
): ContextStrategyResult {
  const agentConfig = binding.spec as {
    designSystem?: { contextStrategyOverride?: string; contextStrategy?: string };
  } & typeof binding.spec;

  // If contextStrategyOverride is 'fixed', use the declared strategy
  if (agentConfig.designSystem?.contextStrategyOverride === 'fixed') {
    const fixed = (agentConfig.designSystem?.contextStrategy ??
      'manifest-first') as ContextStrategy;
    return { strategy: fixed, reason: 'Fixed strategy override — using declared contextStrategy' };
  }

  // Step 1: Token-change trigger with no component modifications
  if (
    task.triggerEvent === 'design-token.changed' &&
    !task.modifiesComponents &&
    !task.createsNewComponent
  ) {
    return {
      strategy: 'tokens-only',
      reason: 'Token-change trigger with no component modifications',
    };
  }

  // Step 2: Modifying/composing existing components only
  if (task.modifiesComponents && !task.createsNewComponent && !task.touchesTokensAndComponents) {
    return {
      strategy: 'manifest-first',
      reason: 'Modifying existing components — manifest sufficient',
    };
  }

  // Step 3: Creating a new component
  if (task.createsNewComponent) {
    return { strategy: 'full', reason: 'New component creation requires full context' };
  }

  // Step 4: Both tokens AND component composition
  if (task.touchesTokensAndComponents) {
    return {
      strategy: 'full',
      reason: 'Task touches both tokens and components — escalating to full',
    };
  }

  // Step 5: Low reusability score
  if (task.reusabilityScore !== undefined && task.reusabilityScore < 0.5) {
    return {
      strategy: 'full',
      reason: `Reusability score ${task.reusabilityScore} < 0.5 — catalog insufficient`,
    };
  }

  // Default
  return { strategy: 'manifest-first', reason: 'Default strategy' };
}

/**
 * Re-evaluate context strategy after scope change (RFC-0006 §7.2 bottom).
 * Called after design impact review if the approved scope differs from
 * the initial scope.
 */
export function reEvaluateStrategy(
  originalTask: TaskContext,
  updatedTask: TaskContext,
  binding: DesignSystemBinding,
): { changed: boolean; result: ContextStrategyResult; reason?: string } {
  const original = selectContextStrategy(originalTask, binding);
  const updated = selectContextStrategy(updatedTask, binding);

  if (original.strategy !== updated.strategy) {
    return {
      changed: true,
      result: updated,
      reason: 'scope-changed-at-impact-review',
    };
  }

  return { changed: false, result: original };
}
