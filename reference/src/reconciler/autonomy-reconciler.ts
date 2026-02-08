/**
 * AutonomyPolicy domain reconciler.
 * Evaluates promotion/demotion for each tracked agent.
 */

import type { AutonomyPolicy } from '../core/types.js';
import { evaluatePromotion, evaluateDemotion, type AgentMetrics } from '../policy/autonomy.js';
import type { ReconcileResult } from './types.js';

export interface AutonomyReconcilerDeps {
  getAgentMetrics: (agentName: string) => AgentMetrics | undefined;
  getActiveTriggers: (agentName: string) => string[];
  onPromotion?: (agent: string, fromLevel: number, toLevel: number) => void;
  onDemotion?: (agent: string, fromLevel: number, toLevel: number, trigger: string) => void;
}

/**
 * Create a reconciler function for AutonomyPolicy resources.
 * Evaluates promotion/demotion for each agent listed in status.
 */
export function createAutonomyReconciler(
  deps: AutonomyReconcilerDeps,
): (resource: AutonomyPolicy) => Promise<ReconcileResult> {
  return async (policy: AutonomyPolicy): Promise<ReconcileResult> => {
    if (!policy.status?.agents || policy.status.agents.length === 0) {
      return { type: 'success' };
    }

    try {
      for (const agentStatus of policy.status.agents) {
        const metrics = deps.getAgentMetrics(agentStatus.name);
        if (!metrics) continue;

        // Check demotion triggers first (safety first)
        const triggers = deps.getActiveTriggers(agentStatus.name);
        let demoted = false;

        for (const trigger of triggers) {
          const result = evaluateDemotion(policy, metrics, trigger);
          if (result.demoted) {
            agentStatus.currentLevel = result.toLevel;
            agentStatus.promotedAt = undefined;
            deps.onDemotion?.(agentStatus.name, result.fromLevel, result.toLevel, trigger);
            demoted = true;
            break;
          }
        }

        if (demoted) continue;

        // Check promotion
        const promotionResult = evaluatePromotion(policy, metrics);
        if (promotionResult.eligible) {
          agentStatus.currentLevel = promotionResult.toLevel;
          agentStatus.promotedAt = new Date().toISOString();
          deps.onPromotion?.(agentStatus.name, promotionResult.fromLevel, promotionResult.toLevel);
        }

        // Update next evaluation time
        agentStatus.nextEvaluationAt = new Date(Date.now() + 3600_000).toISOString();
        agentStatus.metrics = metrics.metrics;
      }

      return { type: 'success' };
    } catch (err) {
      return {
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  };
}
