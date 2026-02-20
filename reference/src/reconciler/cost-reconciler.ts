/**
 * CostReconciler — evaluates a Pipeline's costPolicy against observed
 * cost data and updates status.cost.
 *
 * Follows the createAutonomyReconciler() pattern.
 */

import type { Pipeline } from '../core/types.js';
import type { ReconcileResult } from './types.js';

export interface CostReconcilerDeps {
  getCurrentSpend: (since: string) => number;
  getProjectedSpend: (since: string) => number;
  onAlert?: (alert: string, action: string, targets?: string[]) => void;
  onBudgetExceeded?: (spend: number, budget: number) => void;
}

/**
 * Compute the start-of-period timestamp for a given budget period.
 */
function periodStart(period: 'day' | 'week' | 'month' | 'quarter'): string {
  const now = new Date();
  switch (period) {
    case 'day':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    case 'week': {
      const day = now.getDay();
      const diff = now.getDate() - day;
      return new Date(now.getFullYear(), now.getMonth(), diff).toISOString();
    }
    case 'month':
      return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    case 'quarter': {
      const quarterMonth = Math.floor(now.getMonth() / 3) * 3;
      return new Date(now.getFullYear(), quarterMonth, 1).toISOString();
    }
  }
}

/**
 * Create a reconciler function for Pipeline resources with costPolicy.
 * Evaluates budget alerts and updates status.cost.
 */
export function createCostReconciler(
  deps: CostReconcilerDeps,
): (resource: Pipeline) => Promise<ReconcileResult> {
  return async (resource: Pipeline): Promise<ReconcileResult> => {
    const costPolicy = resource.spec.costPolicy;
    if (!costPolicy?.budget) {
      return { type: 'success' };
    }

    const budget = costPolicy.budget;

    try {
      const since = periodStart(budget.period);
      const currentSpend = deps.getCurrentSpend(since);
      const projectedSpend = deps.getProjectedSpend(since);
      const budgetAmount = budget.amount;
      const budgetRemaining = Math.max(0, budgetAmount - currentSpend);
      const utilization = budgetAmount > 0 ? currentSpend / budgetAmount : 0;

      // Evaluate budget alerts
      const activeAlerts: string[] = [];
      if (budget.alerts) {
        for (const alert of budget.alerts) {
          if (utilization >= alert.threshold) {
            const alertLabel = `${(alert.threshold * 100).toFixed(0)}%`;
            activeAlerts.push(alertLabel);
            deps.onAlert?.(alertLabel, alert.action, alert.targets);
          }
        }
      }

      // Fire budget exceeded callback
      if (currentSpend > budgetAmount) {
        deps.onBudgetExceeded?.(currentSpend, budgetAmount);
      }

      // Update resource status
      if (!resource.status) {
        resource.status = {};
      }
      resource.status.cost = {
        currentSpend,
        budgetRemaining,
        projectedMonthEnd: projectedSpend,
        lastUpdated: new Date().toISOString(),
        activeAlerts: activeAlerts.length > 0 ? activeAlerts : undefined,
      };

      // Requeue periodically to keep cost status fresh
      return { type: 'requeue-after', delayMs: 60_000 };
    } catch (err) {
      return {
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  };
}
