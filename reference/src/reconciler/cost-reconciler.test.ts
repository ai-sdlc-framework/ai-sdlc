import { describe, it, expect, vi } from 'vitest';
import { createCostReconciler } from './cost-reconciler.js';
import type { Pipeline } from '../core/types.js';

const API = 'ai-sdlc.io/v1alpha1' as const;

function makePipeline(budgetAmount = 100): Pipeline {
  return {
    apiVersion: API,
    kind: 'Pipeline',
    metadata: { name: 'test-pipeline' },
    spec: {
      triggers: [{ event: 'issue.opened' }],
      providers: {},
      stages: [{ name: 'code' }],
      costPolicy: {
        budget: {
          period: 'month',
          amount: budgetAmount,
          currency: 'USD',
          alerts: [
            { threshold: 0.8, action: 'notify', targets: ['#ops'] },
            { threshold: 0.95, action: 'require-approval', approver: 'eng-manager' },
          ],
        },
      },
    },
    status: {},
  };
}

describe('createCostReconciler', () => {
  it('updates cost status from deps', async () => {
    const reconciler = createCostReconciler({
      getCurrentSpend: () => 50,
      getProjectedSpend: () => 75,
    });

    const pipeline = makePipeline(100);
    const result = await reconciler(pipeline);

    expect(result.type).toBe('requeue-after');
    expect(pipeline.status?.cost?.currentSpend).toBe(50);
    expect(pipeline.status?.cost?.budgetRemaining).toBe(50);
    expect(pipeline.status?.cost?.projectedMonthEnd).toBe(75);
    expect(pipeline.status?.cost?.lastUpdated).toBeDefined();
  });

  it('fires onAlert for crossed thresholds', async () => {
    const onAlert = vi.fn();
    const reconciler = createCostReconciler({
      getCurrentSpend: () => 85,
      getProjectedSpend: () => 120,
      onAlert,
    });

    const pipeline = makePipeline(100);
    await reconciler(pipeline);

    // 85% utilization crosses the 80% threshold but not 95%
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert).toHaveBeenCalledWith('80%', 'notify', ['#ops']);
  });

  it('fires multiple alerts when multiple thresholds crossed', async () => {
    const onAlert = vi.fn();
    const reconciler = createCostReconciler({
      getCurrentSpend: () => 96,
      getProjectedSpend: () => 130,
      onAlert,
    });

    const pipeline = makePipeline(100);
    await reconciler(pipeline);

    // 96% crosses both 80% and 95%
    expect(onAlert).toHaveBeenCalledTimes(2);
  });

  it('fires onBudgetExceeded when over budget', async () => {
    const onBudgetExceeded = vi.fn();
    const reconciler = createCostReconciler({
      getCurrentSpend: () => 110,
      getProjectedSpend: () => 150,
      onBudgetExceeded,
    });

    const pipeline = makePipeline(100);
    await reconciler(pipeline);

    expect(onBudgetExceeded).toHaveBeenCalledWith(110, 100);
    expect(pipeline.status?.cost?.budgetRemaining).toBe(0);
  });

  it('succeeds with no costPolicy', async () => {
    const reconciler = createCostReconciler({
      getCurrentSpend: () => 0,
      getProjectedSpend: () => 0,
    });

    const pipeline: Pipeline = {
      apiVersion: API,
      kind: 'Pipeline',
      metadata: { name: 'no-cost' },
      spec: {
        triggers: [{ event: 'issue.opened' }],
        providers: {},
        stages: [{ name: 'code' }],
      },
    };

    const result = await reconciler(pipeline);
    expect(result.type).toBe('success');
  });

  it('sets activeAlerts when thresholds are crossed', async () => {
    const reconciler = createCostReconciler({
      getCurrentSpend: () => 96,
      getProjectedSpend: () => 130,
    });

    const pipeline = makePipeline(100);
    await reconciler(pipeline);

    expect(pipeline.status?.cost?.activeAlerts).toEqual(['80%', '95%']);
  });

  it('does not set activeAlerts when no thresholds are crossed', async () => {
    const reconciler = createCostReconciler({
      getCurrentSpend: () => 10,
      getProjectedSpend: () => 30,
    });

    const pipeline = makePipeline(100);
    await reconciler(pipeline);

    expect(pipeline.status?.cost?.activeAlerts).toBeUndefined();
  });

  it('returns error on exception', async () => {
    const reconciler = createCostReconciler({
      getCurrentSpend: () => {
        throw new Error('db failure');
      },
      getProjectedSpend: () => 0,
    });

    const pipeline = makePipeline(100);
    const result = await reconciler(pipeline);

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.error.message).toBe('db failure');
    }
  });

  it('initializes status object when missing', async () => {
    const reconciler = createCostReconciler({
      getCurrentSpend: () => 25,
      getProjectedSpend: () => 50,
    });

    const pipeline = makePipeline(100);
    (pipeline as { status?: unknown }).status = undefined;

    await reconciler(pipeline);
    expect(pipeline.status?.cost?.currentSpend).toBe(25);
  });
});
