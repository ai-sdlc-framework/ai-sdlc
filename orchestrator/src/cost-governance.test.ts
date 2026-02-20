import { describe, it, expect, vi } from 'vitest';
import { CostGovernancePlugin } from './cost-governance.js';
import type { CostPolicy } from '@ai-sdlc/reference';
import type { CostTracker, BudgetStatus } from './cost-tracker.js';
import type { Logger } from './logger.js';
import type { NotificationRouter } from './notifications/notification-router.js';

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    error: vi.fn(),
    stage: vi.fn(),
    stageEnd: vi.fn(),
    summary: vi.fn(),
  };
}

function makeCostTracker(overrides: Partial<BudgetStatus> = {}): CostTracker {
  const budgetStatus: BudgetStatus = {
    budgetUsd: 100,
    spentUsd: 50,
    remainingUsd: 50,
    utilizationPercent: 50,
    overBudget: false,
    projectedMonthlyUsd: 75,
    ...overrides,
  };
  return {
    getBudgetStatus: vi.fn().mockReturnValue(budgetStatus),
    recordCost: vi.fn(),
    getCostSummary: vi.fn(),
    getCostByAgent: vi.fn(),
    getCostTimeSeries: vi.fn(),
  } as unknown as CostTracker;
}

function makeNotificationRouter(): NotificationRouter {
  return {
    dispatch: vi.fn().mockResolvedValue(undefined),
    addRoute: vi.fn(),
    removeRoute: vi.fn(),
    routeCount: 0,
  } as unknown as NotificationRouter;
}

function makeEvent() {
  return {
    runId: 'run-1',
    issueNumber: 42,
    startedAt: new Date().toISOString(),
  };
}

describe('CostGovernancePlugin', () => {
  describe('initialize', () => {
    it('stores cost tracker and log', () => {
      const policy: CostPolicy = {
        budget: { period: 'month', amount: 100, currency: 'USD' },
      };
      const plugin = new CostGovernancePlugin(policy);
      const log = makeLogger();
      const costTracker = makeCostTracker();

      plugin.initialize({ costTracker, log });
      expect(plugin.name).toBe('cost-governance');
    });
  });

  describe('beforeRun', () => {
    it('throws when budget exceeded and hard limit action is abort', async () => {
      const policy: CostPolicy = {
        budget: { period: 'month', amount: 100, currency: 'USD' },
        perExecution: {
          hardLimit: { amount: 10, currency: 'USD', action: 'abort' },
        },
      };
      const plugin = new CostGovernancePlugin(policy);
      const log = makeLogger();
      const costTracker = makeCostTracker({ overBudget: true, spentUsd: 110, budgetUsd: 100 });

      plugin.initialize({ costTracker, log });

      await expect(plugin.beforeRun(makeEvent())).rejects.toThrow(
        'Cost governance: budget exceeded',
      );
    });

    it('does not throw when budget is within limits', async () => {
      const policy: CostPolicy = {
        budget: { period: 'month', amount: 100, currency: 'USD' },
        perExecution: {
          hardLimit: { amount: 10, currency: 'USD', action: 'abort' },
        },
      };
      const plugin = new CostGovernancePlugin(policy);
      const log = makeLogger();
      const costTracker = makeCostTracker({ overBudget: false });

      plugin.initialize({ costTracker, log });

      await expect(plugin.beforeRun(makeEvent())).resolves.not.toThrow();
    });

    it('logs warning when hard limit action is require-approval', async () => {
      const policy: CostPolicy = {
        budget: { period: 'month', amount: 100, currency: 'USD' },
        perExecution: {
          hardLimit: { amount: 10, currency: 'USD', action: 'require-approval' },
        },
      };
      const plugin = new CostGovernancePlugin(policy);
      const log = makeLogger();
      const costTracker = makeCostTracker({ overBudget: true, spentUsd: 110, budgetUsd: 100 });

      plugin.initialize({ costTracker, log });
      await plugin.beforeRun(makeEvent());

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Approval required'));
    });

    it('does nothing when no cost tracker is available', async () => {
      const policy: CostPolicy = {
        perExecution: {
          hardLimit: { amount: 10, currency: 'USD', action: 'abort' },
        },
      };
      const plugin = new CostGovernancePlugin(policy);
      const log = makeLogger();

      plugin.initialize({ log });

      await expect(plugin.beforeRun(makeEvent())).resolves.not.toThrow();
    });

    it('does nothing when no hard limit is configured', async () => {
      const policy: CostPolicy = {
        budget: { period: 'month', amount: 100, currency: 'USD' },
      };
      const plugin = new CostGovernancePlugin(policy);
      const log = makeLogger();
      const costTracker = makeCostTracker({ overBudget: true });

      plugin.initialize({ costTracker, log });

      await expect(plugin.beforeRun(makeEvent())).resolves.not.toThrow();
    });

    it('logs and dispatches notification when soft limit reached', async () => {
      const policy: CostPolicy = {
        budget: { period: 'month', amount: 100, currency: 'USD' },
        perExecution: {
          softLimit: { amount: 40, currency: 'USD', action: 'notify' },
        },
      };
      const plugin = new CostGovernancePlugin(policy);
      const log = makeLogger();
      const costTracker = makeCostTracker({ spentUsd: 50 });
      const notificationRouter = makeNotificationRouter();

      plugin.initialize({ costTracker, log, notificationRouter });
      await plugin.beforeRun(makeEvent());

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('soft limit reached'));
      expect(notificationRouter.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'cost-alert',
          severity: 'warning',
          data: expect.objectContaining({ threshold: 'soft-limit' }),
        }),
      );
    });

    it('does not trigger soft limit when under threshold', async () => {
      const policy: CostPolicy = {
        budget: { period: 'month', amount: 100, currency: 'USD' },
        perExecution: {
          softLimit: { amount: 80, currency: 'USD', action: 'notify' },
        },
      };
      const plugin = new CostGovernancePlugin(policy);
      const log = makeLogger();
      const costTracker = makeCostTracker({ spentUsd: 50 });

      plugin.initialize({ costTracker, log });
      await plugin.beforeRun(makeEvent());

      expect(log.info).not.toHaveBeenCalled();
    });
  });

  describe('afterRun', () => {
    it('logs alerts for crossed thresholds', async () => {
      const policy: CostPolicy = {
        budget: {
          period: 'month',
          amount: 100,
          currency: 'USD',
          alerts: [
            { threshold: 0.8, action: 'notify' },
            { threshold: 0.95, action: 'require-approval' },
          ],
        },
      };
      const plugin = new CostGovernancePlugin(policy);
      const log = makeLogger();
      const costTracker = makeCostTracker({ utilizationPercent: 90 });

      plugin.initialize({ costTracker, log });

      await plugin.afterRun({
        runId: 'run-1',
        issueNumber: 42,
        result: { prUrl: 'url', filesChanged: [], promotionEligible: false },
        durationMs: 1000,
      });

      // 90% utilization crosses 80% but not 95%
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('80% budget consumed'));
    });

    it('logs multiple alerts when multiple thresholds crossed', async () => {
      const policy: CostPolicy = {
        budget: {
          period: 'month',
          amount: 100,
          currency: 'USD',
          alerts: [
            { threshold: 0.8, action: 'notify' },
            { threshold: 0.95, action: 'require-approval' },
          ],
        },
      };
      const plugin = new CostGovernancePlugin(policy);
      const log = makeLogger();
      const costTracker = makeCostTracker({ utilizationPercent: 97 });

      plugin.initialize({ costTracker, log });

      await plugin.afterRun({
        runId: 'run-1',
        issueNumber: 42,
        result: { prUrl: 'url', filesChanged: [], promotionEligible: false },
        durationMs: 1000,
      });

      expect(log.info).toHaveBeenCalledTimes(2);
    });

    it('dispatches notifications for crossed thresholds', async () => {
      const policy: CostPolicy = {
        budget: {
          period: 'month',
          amount: 100,
          currency: 'USD',
          alerts: [{ threshold: 0.8, action: 'notify' }],
        },
      };
      const plugin = new CostGovernancePlugin(policy);
      const log = makeLogger();
      const costTracker = makeCostTracker({ utilizationPercent: 90 });
      const notificationRouter = makeNotificationRouter();

      plugin.initialize({ costTracker, log, notificationRouter });

      await plugin.afterRun({
        runId: 'run-1',
        issueNumber: 42,
        result: { prUrl: 'url', filesChanged: [], promotionEligible: false },
        durationMs: 1000,
      });

      expect(notificationRouter.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'cost-alert',
          severity: 'warning',
          data: expect.objectContaining({
            threshold: '80',
            action: 'notify',
          }),
        }),
      );
    });

    it('does nothing when no alerts configured', async () => {
      const policy: CostPolicy = {
        budget: { period: 'month', amount: 100, currency: 'USD' },
      };
      const plugin = new CostGovernancePlugin(policy);
      const log = makeLogger();
      const costTracker = makeCostTracker();

      plugin.initialize({ costTracker, log });

      await plugin.afterRun({
        runId: 'run-1',
        issueNumber: 42,
        result: { prUrl: 'url', filesChanged: [], promotionEligible: false },
        durationMs: 1000,
      });

      expect(log.info).not.toHaveBeenCalled();
    });
  });
});
