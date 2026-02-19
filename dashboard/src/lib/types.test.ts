import { describe, it, expect } from 'vitest';
import type { RunSummary, AgentSummary, CostSummaryResponse, HealthResponse } from './types';

describe('Dashboard types', () => {
  it('RunSummary has correct shape', () => {
    const run: RunSummary = {
      runId: 'r-1',
      pipelineType: 'feature',
      status: 'completed',
    };
    expect(run.runId).toBe('r-1');
    expect(run.issueNumber).toBeUndefined();
  });

  it('AgentSummary has correct shape', () => {
    const agent: AgentSummary = {
      agentName: 'dev',
      currentLevel: 2,
      totalTasks: 10,
      successRate: 0.9,
    };
    expect(agent.successRate).toBe(0.9);
  });

  it('CostSummaryResponse has correct shape', () => {
    const cost: CostSummaryResponse = {
      totalCostUsd: 5.5,
      totalTokens: 100000,
      runCount: 10,
      byAgent: [{ agentName: 'dev', costUsd: 5.5, runs: 10 }],
      timeSeries: [{ date: '2026-01-01', costUsd: 1.0, runs: 2 }],
    };
    expect(cost.byAgent).toHaveLength(1);
    expect(cost.byModel).toBeUndefined();
    expect(cost.budget).toBeUndefined();
  });

  it('CostSummaryResponse supports optional byModel and budget', () => {
    const cost: CostSummaryResponse = {
      totalCostUsd: 10.0,
      totalTokens: 200000,
      runCount: 20,
      byAgent: [{ agentName: 'dev', costUsd: 10.0, runs: 20 }],
      timeSeries: [],
      byModel: [{ model: 'claude-sonnet-4-5-20250929', costUsd: 8.0, runs: 15 }],
      budget: {
        budgetUsd: 500,
        spentUsd: 10.0,
        remainingUsd: 490,
        utilizationPercent: 2,
        overBudget: false,
        projectedMonthlyUsd: 50,
      },
    };
    expect(cost.byModel).toHaveLength(1);
    expect(cost.budget?.overBudget).toBe(false);
    expect(cost.budget?.remainingUsd).toBe(490);
  });

  it('HealthResponse has correct shape', () => {
    const health: HealthResponse = {
      status: 'healthy',
      runsTotal: 100,
      runsLast24h: 5,
      failureRate24h: 0.1,
      activeAgents: 3,
    };
    expect(health.status).toBe('healthy');
  });
});
