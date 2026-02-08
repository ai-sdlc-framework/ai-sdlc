/**
 * Autonomy policy evaluation — promotion and demotion logic.
 * Implements the autonomy level transitions from spec/policy.md.
 */

import type { AutonomyPolicy, DemotionTrigger } from '../core/types.js';
import { compareMetric } from '../core/compare.js';

export interface AgentMetrics {
  name: string;
  currentLevel: number;
  totalTasksCompleted: number;
  metrics: Record<string, number>;
  approvals: string[];
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

/**
 * Evaluate whether an agent should be demoted based on a trigger event.
 */
export function evaluateDemotion(
  policy: AutonomyPolicy,
  agent: AgentMetrics,
  activeTrigger: string,
): DemotionResult {
  const fromLevel = agent.currentLevel;
  const match = policy.spec.demotionTriggers.find(
    (t: DemotionTrigger) => t.trigger === activeTrigger,
  );

  if (!match) {
    return { demoted: false, fromLevel, toLevel: fromLevel };
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
