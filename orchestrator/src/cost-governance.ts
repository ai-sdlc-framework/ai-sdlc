/**
 * CostGovernancePlugin — orchestrator plugin that wires budget checks,
 * circuit breaker, and cost alert evaluation into the pipeline lifecycle.
 *
 * Registered automatically when a Pipeline has a costPolicy.
 */

import type { CostPolicy } from '@ai-sdlc/reference';
import type { OrchestratorPlugin, PluginContext, BeforeRunEvent, AfterRunEvent } from './plugin.js';
import type { CostTracker } from './cost-tracker.js';
import type { Logger } from './logger.js';
import type { NotificationRouter } from './notifications/notification-router.js';

/**
 * Compute the start of the current budget period.
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

export class CostGovernancePlugin implements OrchestratorPlugin {
  name = 'cost-governance';

  private costTracker?: CostTracker;
  private notificationRouter?: NotificationRouter;
  private log!: Logger;
  private budgetAmount?: number;
  private budgetPeriod?: 'day' | 'week' | 'month' | 'quarter';

  constructor(private costPolicy: CostPolicy) {}

  initialize(ctx: PluginContext): void {
    this.costTracker = ctx.costTracker;
    this.notificationRouter = ctx.notificationRouter;
    this.log = ctx.log;
    this.budgetAmount = this.costPolicy.budget?.amount;
    this.budgetPeriod = this.costPolicy.budget?.period;
  }

  async beforeRun(_event: BeforeRunEvent): Promise<void> {
    const since = this.budgetPeriod ? periodStart(this.budgetPeriod) : undefined;

    // Circuit breaker: check hard limit against current budget status
    if (this.costTracker && this.costPolicy.perExecution?.hardLimit) {
      const budget = this.costTracker.getBudgetStatus(this.budgetAmount, since);

      if (budget.overBudget && this.costPolicy.perExecution.hardLimit.action === 'abort') {
        throw new Error(
          `Cost governance: budget exceeded ($${budget.spentUsd.toFixed(2)} / $${budget.budgetUsd.toFixed(2)}). Execution aborted.`,
        );
      }

      if (
        budget.overBudget &&
        this.costPolicy.perExecution.hardLimit.action === 'require-approval'
      ) {
        this.log.info(
          `Cost governance: budget exceeded ($${budget.spentUsd.toFixed(2)} / $${budget.budgetUsd.toFixed(2)}). Approval required.`,
        );
      }
    }

    // Soft limit check
    if (this.costTracker && this.costPolicy.perExecution?.softLimit) {
      const budget = this.costTracker.getBudgetStatus(this.budgetAmount, since);
      if (budget.spentUsd >= this.costPolicy.perExecution.softLimit.amount) {
        this.log.info(
          `Cost governance: soft limit reached ($${budget.spentUsd.toFixed(2)} >= $${this.costPolicy.perExecution.softLimit.amount.toFixed(2)})`,
        );
        if (this.notificationRouter) {
          await this.notificationRouter.dispatch({
            type: 'cost-alert',
            data: {
              utilization: budget.utilizationPercent.toFixed(0),
              spent: budget.spentUsd.toFixed(2),
              budget: budget.budgetUsd.toFixed(2),
              threshold: 'soft-limit',
              action: this.costPolicy.perExecution.softLimit.action,
            },
            severity: 'warning',
          });
        }
      }
    }
  }

  async afterRun(_event: AfterRunEvent): Promise<void> {
    // Evaluate budget alerts after each run
    if (this.costTracker && this.costPolicy.budget?.alerts) {
      const since = this.budgetPeriod ? periodStart(this.budgetPeriod) : undefined;
      const budget = this.costTracker.getBudgetStatus(this.budgetAmount, since);

      for (const alert of this.costPolicy.budget.alerts) {
        if (budget.utilizationPercent / 100 >= alert.threshold) {
          this.log.info(
            `Cost alert: ${(alert.threshold * 100).toFixed(0)}% budget consumed (action: ${alert.action})`,
          );

          if (this.notificationRouter) {
            await this.notificationRouter.dispatch({
              type: 'cost-alert',
              data: {
                utilization: budget.utilizationPercent.toFixed(0),
                spent: budget.spentUsd.toFixed(2),
                budget: budget.budgetUsd.toFixed(2),
                threshold: (alert.threshold * 100).toFixed(0),
                action: alert.action,
              },
              severity: 'warning',
            });
          }
        }
      }
    }
  }
}
