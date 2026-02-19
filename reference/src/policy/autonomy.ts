/**
 * Autonomy policy evaluation — promotion and demotion logic.
 * Implements the autonomy level transitions from spec/policy.md.
 */

import type { AutonomyPolicy, DemotionTrigger, DemotionTriggerCondition, Duration } from '../core/types.js';
import { compareMetric } from '../core/compare.js';

/** Default cooldown after demotion: 1 hour. */
export const DEFAULT_COOLDOWN_MS = 3_600_000;

export interface AgentMetrics {
  name: string;
  currentLevel: number;
  totalTasksCompleted: number;
  metrics: Record<string, number>;
  approvals: string[];
  promotedAt?: Date;
  demotedAt?: Date;
}

export interface PromotionResult {
  eligible: boolean;
  fromLevel: number;
  toLevel: number;
  unmetConditions: string[];
}

export interface DemotionResult {
  demoted: boolean;
  trigger?: string;
  fromLevel: number;
  toLevel: number;
}

/**
 * Parse a duration string to milliseconds.
 * Supports: 60s, 5m, 2h, 1d, 2w, and ISO 8601 (P1D, PT1H, etc.).
 */
export function parseDuration(d: Duration): number {
  if (!d) return 0;

  // Simple format: number + unit suffix
  const simple = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i.exec(d);
  if (simple) {
    const value = parseFloat(simple[1]);
    switch (simple[2].toLowerCase()) {
      case 's':
        return value * 1000;
      case 'm':
        return value * 60 * 1000;
      case 'h':
        return value * 60 * 60 * 1000;
      case 'd':
        return value * 24 * 60 * 60 * 1000;
      case 'w':
        return value * 7 * 24 * 60 * 60 * 1000;
    }
  }

  // ISO 8601 duration: P[nD][T[nH][nM][nS]]
  const iso = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(d);
  if (iso) {
    const days = parseInt(iso[1] || '0', 10);
    const hours = parseInt(iso[2] || '0', 10);
    const minutes = parseInt(iso[3] || '0', 10);
    const seconds = parseFloat(iso[4] || '0');
    return days * 86_400_000 + hours * 3_600_000 + minutes * 60_000 + seconds * 1000;
  }

  return 0;
}

/**
 * Evaluate whether an agent is eligible for promotion to the next autonomy level.
 */
export function evaluatePromotion(policy: AutonomyPolicy, agent: AgentMetrics): PromotionResult {
  const fromLevel = agent.currentLevel;
  const toLevel = fromLevel + 1;
  const key = `${fromLevel}-to-${toLevel}`;
  const criteria = policy.spec.promotionCriteria[key];

  if (!criteria) {
    return {
      eligible: false,
      fromLevel,
      toLevel,
      unmetConditions: [`No promotion criteria defined for ${key}`],
    };
  }

  const unmetConditions: string[] = [];

  // Check minimumDuration at current level
  const currentLevelDef = policy.spec.levels.find((l) => l.level === fromLevel);
  if (currentLevelDef?.minimumDuration && agent.promotedAt) {
    const minMs = parseDuration(currentLevelDef.minimumDuration);
    const elapsed = Date.now() - agent.promotedAt.getTime();
    if (elapsed < minMs) {
      unmetConditions.push(
        `Minimum duration at level ${fromLevel} not met: ${elapsed}ms < ${minMs}ms`,
      );
    }
  }

  // Check demotion cooldown
  if (agent.demotedAt) {
    // Find matching demotion trigger cooldown (use longest)
    let cooldownMs = 0;
    for (const trigger of policy.spec.demotionTriggers) {
      const cd = parseDuration(trigger.cooldown);
      if (cd > cooldownMs) cooldownMs = cd;
    }
    if (cooldownMs === 0) cooldownMs = DEFAULT_COOLDOWN_MS;

    const elapsed = Date.now() - agent.demotedAt.getTime();
    if (elapsed < cooldownMs) {
      unmetConditions.push(`Demotion cooldown not expired: ${elapsed}ms < ${cooldownMs}ms`);
    }
  }

  if (agent.totalTasksCompleted < criteria.minimumTasks) {
    unmetConditions.push(`Minimum tasks: ${agent.totalTasksCompleted}/${criteria.minimumTasks}`);
  }

  for (const condition of criteria.conditions) {
    const actual = agent.metrics[condition.metric];
    if (actual === undefined) {
      unmetConditions.push(`Metric "${condition.metric}" not available`);
      continue;
    }
    if (!compareMetric(actual, condition.operator, condition.threshold)) {
      unmetConditions.push(
        `${condition.metric}: ${actual} ${condition.operator} ${condition.threshold} failed`,
      );
    }
  }

  for (const approval of criteria.requiredApprovals) {
    if (!agent.approvals.includes(approval)) {
      unmetConditions.push(`Missing approval: ${approval}`);
    }
  }

  return {
    eligible: unmetConditions.length === 0,
    fromLevel,
    toLevel,
    unmetConditions,
  };
}

export interface DemotionConditionContext {
  metrics: Record<string, number>;
  /** Per-metric history for window evaluation (most recent first). */
  metricHistory?: Record<string, number[]>;
}

/**
 * Evaluate a demotion trigger condition against observed metrics.
 */
export function evaluateDemotionCondition(
  condition: DemotionTriggerCondition,
  ctx: DemotionConditionContext,
): boolean {
  if (condition.window && ctx.metricHistory) {
    const history = ctx.metricHistory[condition.metric];
    if (!history || history.length < condition.window) return false;
    const windowValues = history.slice(0, condition.window);
    return windowValues.every(v => compareMetric(v, condition.operator, condition.threshold));
  }
  const actual = ctx.metrics[condition.metric];
  if (actual === undefined) return false;
  return compareMetric(actual, condition.operator, condition.threshold);
}

/**
 * Evaluate whether an agent should be demoted based on a trigger event.
 */
export function evaluateDemotion(
  policy: AutonomyPolicy,
  agent: AgentMetrics,
  activeTrigger: string,
  conditionCtx?: DemotionConditionContext,
): DemotionResult {
  const fromLevel = agent.currentLevel;
  const match = policy.spec.demotionTriggers.find(
    (t: DemotionTrigger) => t.trigger === activeTrigger,
  );

  if (!match) {
    return { demoted: false, fromLevel, toLevel: fromLevel };
  }

  // If the trigger has a condition, evaluate it
  if (match.condition) {
    if (!conditionCtx || !evaluateDemotionCondition(match.condition, conditionCtx)) {
      return { demoted: false, fromLevel, toLevel: fromLevel };
    }
  }

  let toLevel: number;
  if (match.action === 'demote-to-0') {
    toLevel = 0;
  } else {
    // demote-one-level
    toLevel = Math.max(0, fromLevel - 1);
  }

  return {
    demoted: true,
    trigger: match.trigger,
    fromLevel,
    toLevel,
  };
}
