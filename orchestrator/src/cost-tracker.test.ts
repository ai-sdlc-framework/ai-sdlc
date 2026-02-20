import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from './state/store.js';
import { CostTracker } from './cost-tracker.js';

describe('CostTracker', () => {
  let store: StateStore;
  let tracker: CostTracker;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = StateStore.open(db);
    tracker = new CostTracker(store);
  });

  describe('computeCost', () => {
    it('computes cost for known models', () => {
      const cost = CostTracker.computeCost(1000, 500, 'claude-sonnet-4-5-20250929');
      // 1000 * 3 / 1M + 500 * 15 / 1M = 0.003 + 0.0075 = 0.0105
      expect(cost).toBeCloseTo(0.0105, 4);
    });

    it('uses fallback pricing for unknown models', () => {
      const cost = CostTracker.computeCost(1000, 500, 'unknown-model');
      expect(cost).toBeGreaterThan(0);
    });

    it('computes opus cost correctly', () => {
      const cost = CostTracker.computeCost(10000, 5000, 'claude-opus-4-6');
      // 10000 * 15 / 1M + 5000 * 75 / 1M = 0.15 + 0.375 = 0.525
      expect(cost).toBeCloseTo(0.525, 3);
    });
  });

  describe('recordCost', () => {
    it('records a cost entry', () => {
      const id = tracker.recordCost({
        runId: 'run-1',
        agentName: 'code-agent',
        pipelineType: 'execute',
        model: 'claude-sonnet-4-5-20250929',
        inputTokens: 5000,
        outputTokens: 2000,
      });
      expect(id).toBeGreaterThan(0);
    });

    it('auto-computes cost from tokens and model', () => {
      tracker.recordCost({
        runId: 'run-1',
        agentName: 'code-agent',
        pipelineType: 'execute',
        model: 'claude-sonnet-4-5-20250929',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      });

      const entries = store.getCostEntries({ runId: 'run-1' });
      expect(entries).toHaveLength(1);
      // 1M * 3/1M + 500K * 15/1M = 3 + 7.5 = 10.5
      expect(entries[0].costUsd).toBeCloseTo(10.5, 1);
    });

    it('auto-computes totalTokens', () => {
      tracker.recordCost({
        runId: 'run-1',
        agentName: 'code-agent',
        pipelineType: 'execute',
        inputTokens: 3000,
        outputTokens: 1000,
      });

      const entries = store.getCostEntries({ runId: 'run-1' });
      expect(entries[0].totalTokens).toBe(4000);
    });
  });

  describe('getCostSummary', () => {
    it('returns empty summary when no entries', () => {
      const summary = tracker.getCostSummary();
      expect(summary.totalCostUsd).toBe(0);
      expect(summary.entryCount).toBe(0);
      expect(summary.avgCostPerRun).toBe(0);
    });

    it('aggregates costs correctly', () => {
      tracker.recordCost({
        runId: 'run-1',
        agentName: 'agent-a',
        pipelineType: 'execute',
        model: 'claude-sonnet-4-5-20250929',
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.1,
      });
      tracker.recordCost({
        runId: 'run-2',
        agentName: 'agent-b',
        pipelineType: 'execute',
        model: 'claude-opus-4-6',
        inputTokens: 2000,
        outputTokens: 1000,
        costUsd: 0.5,
      });

      const summary = tracker.getCostSummary();
      expect(summary.totalCostUsd).toBeCloseTo(0.6, 2);
      expect(summary.entryCount).toBe(2);
      expect(summary.avgCostPerRun).toBeCloseTo(0.3, 2);
      expect(summary.costByAgent['agent-a']).toBeCloseTo(0.1, 2);
      expect(summary.costByAgent['agent-b']).toBeCloseTo(0.5, 2);
      expect(summary.costByModel['claude-sonnet-4-5-20250929']).toBeCloseTo(0.1, 2);
      expect(summary.costByModel['claude-opus-4-6']).toBeCloseTo(0.5, 2);
    });
  });

  describe('getBudgetStatus', () => {
    it('returns correct status under budget', () => {
      tracker.recordCost({
        runId: 'run-1',
        agentName: 'agent-a',
        pipelineType: 'execute',
        costUsd: 100,
      });

      const status = tracker.getBudgetStatus(500);
      expect(status.budgetUsd).toBe(500);
      expect(status.spentUsd).toBe(100);
      expect(status.remainingUsd).toBe(400);
      expect(status.utilizationPercent).toBeCloseTo(20, 0);
      expect(status.overBudget).toBe(false);
    });

    it('detects over budget', () => {
      tracker.recordCost({
        runId: 'run-1',
        agentName: 'agent-a',
        pipelineType: 'execute',
        costUsd: 600,
      });

      const status = tracker.getBudgetStatus(500);
      expect(status.overBudget).toBe(true);
      expect(status.remainingUsd).toBe(0);
    });

    it('uses default budget when none specified', () => {
      const status = tracker.getBudgetStatus();
      expect(status.budgetUsd).toBe(500); // DEFAULT_COST_BUDGET_USD
    });
  });

  describe('getCostByAgent', () => {
    it('returns cost breakdown by agent', () => {
      tracker.recordCost({
        runId: 'r1',
        agentName: 'agent-a',
        pipelineType: 'execute',
        costUsd: 1.0,
        totalTokens: 1000,
      });
      tracker.recordCost({
        runId: 'r2',
        agentName: 'agent-a',
        pipelineType: 'execute',
        costUsd: 2.0,
        totalTokens: 2000,
      });
      tracker.recordCost({
        runId: 'r3',
        agentName: 'agent-b',
        pipelineType: 'execute',
        costUsd: 0.5,
        totalTokens: 500,
      });

      const byAgent = tracker.getCostByAgent();
      expect(byAgent['agent-a'].costUsd).toBeCloseTo(3.0, 2);
      expect(byAgent['agent-a'].runs).toBe(2);
      expect(byAgent['agent-b'].costUsd).toBeCloseTo(0.5, 2);
      expect(byAgent['agent-b'].runs).toBe(1);
    });

    it('returns empty for no entries', () => {
      const byAgent = tracker.getCostByAgent();
      expect(Object.keys(byAgent)).toHaveLength(0);
    });
  });

  describe('getCostTimeSeries', () => {
    it('returns empty for no entries', () => {
      const series = tracker.getCostTimeSeries('day');
      expect(series).toHaveLength(0);
    });

    it('groups by day', () => {
      tracker.recordCost({
        runId: 'r1',
        agentName: 'agent-a',
        pipelineType: 'execute',
        costUsd: 1.0,
        totalTokens: 1000,
      });
      tracker.recordCost({
        runId: 'r2',
        agentName: 'agent-a',
        pipelineType: 'execute',
        costUsd: 2.0,
        totalTokens: 2000,
      });

      const series = tracker.getCostTimeSeries('day');
      // Both entries should be on the same day
      expect(series.length).toBeGreaterThanOrEqual(1);
      expect(series[0].costUsd).toBeCloseTo(3.0, 2);
      expect(series[0].runCount).toBe(2);
    });
  });
});
