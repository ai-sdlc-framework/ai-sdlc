import { describe, it, expect } from 'vitest';
import {
  renderPipelinePanel,
  renderAgentPanel,
  renderCostPanel,
  renderHeaderPanel,
  renderDashboardFrame,
  type DashboardData,
} from './dashboard-renderer.js';

const WIDTH = 80;

describe('dashboard-renderer', () => {
  const emptyData: DashboardData = {
    runs: [],
    agents: [],
    costSummary: {
      totalCostUsd: 0,
      totalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      entryCount: 0,
      avgCostPerRun: 0,
      avgTokensPerRun: 0,
      costByAgent: {},
      costByModel: {},
    },
    budgetStatus: {
      budgetUsd: 500,
      spentUsd: 0,
      remainingUsd: 500,
      utilizationPercent: 0,
      overBudget: false,
      projectedMonthlyUsd: 0,
    },
  };

  const fixtureData: DashboardData = {
    runs: [
      { runId: 'run-12345-42', status: 'completed', startedAt: '2025-01-15T10:30:00Z' },
      { runId: 'run-67890-43', status: 'running', startedAt: '2025-01-15T11:00:00Z' },
    ],
    agents: [
      {
        agentName: 'code-agent',
        currentLevel: 2,
        totalTasks: 15,
        successCount: 13,
        failureCount: 2,
        lastTaskAt: '2025-01-15T10:30:00Z',
      },
      {
        agentName: 'review-agent',
        currentLevel: 1,
        totalTasks: 8,
        successCount: 7,
        failureCount: 1,
        lastTaskAt: '2025-01-14T14:00:00Z',
      },
    ],
    costSummary: {
      totalCostUsd: 12.5,
      totalTokens: 1500000,
      totalInputTokens: 1000000,
      totalOutputTokens: 500000,
      entryCount: 15,
      avgCostPerRun: 0.833,
      avgTokensPerRun: 100000,
      costByAgent: { 'code-agent': 10.0, 'review-agent': 2.5 },
      costByModel: { 'claude-sonnet-4-5-20250929': 12.5 },
    },
    budgetStatus: {
      budgetUsd: 500,
      spentUsd: 12.5,
      remainingUsd: 487.5,
      utilizationPercent: 2.5,
      overBudget: false,
      projectedMonthlyUsd: 37.5,
    },
  };

  describe('renderHeaderPanel', () => {
    it('renders header with timestamp', () => {
      const lines = renderHeaderPanel(WIDTH);
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(lines[0]).toContain('AI-SDLC Dashboard');
      expect(lines[1]).toContain('Updated:');
    });
  });

  describe('renderPipelinePanel', () => {
    it('renders empty state', () => {
      const lines = renderPipelinePanel([], WIDTH);
      expect(lines.some((l) => l.includes('No recent runs'))).toBe(true);
    });

    it('renders runs', () => {
      const lines = renderPipelinePanel(fixtureData.runs, WIDTH);
      expect(lines.some((l) => l.includes('run-12345'))).toBe(true);
      expect(lines.some((l) => l.includes('completed'))).toBe(true);
      expect(lines.some((l) => l.includes('running'))).toBe(true);
    });
  });

  describe('renderAgentPanel', () => {
    it('renders empty state', () => {
      const lines = renderAgentPanel([], WIDTH);
      expect(lines.some((l) => l.includes('No agents registered'))).toBe(true);
    });

    it('renders agents with metrics', () => {
      const lines = renderAgentPanel(fixtureData.agents, WIDTH);
      expect(lines.some((l) => l.includes('code-agent'))).toBe(true);
      expect(lines.some((l) => l.includes('87%'))).toBe(true); // 13/15
    });
  });

  describe('renderCostPanel', () => {
    it('renders cost summary', () => {
      const lines = renderCostPanel(fixtureData.costSummary, fixtureData.budgetStatus, WIDTH);
      expect(lines.some((l) => l.includes('$12.50'))).toBe(true);
      expect(lines.some((l) => l.includes('1.5M'))).toBe(true);
    });

    it('renders empty cost state', () => {
      const lines = renderCostPanel(emptyData.costSummary, emptyData.budgetStatus, WIDTH);
      expect(lines.some((l) => l.includes('$0.00'))).toBe(true);
    });

    it('renders over budget warning', () => {
      const overBudget = { ...fixtureData.budgetStatus, overBudget: true, utilizationPercent: 110 };
      const lines = renderCostPanel(fixtureData.costSummary, overBudget, WIDTH);
      expect(lines.some((l) => l.includes('OVER BUDGET'))).toBe(true);
    });

    it('renders cost by agent', () => {
      const lines = renderCostPanel(fixtureData.costSummary, fixtureData.budgetStatus, WIDTH);
      expect(lines.some((l) => l.includes('code-agent'))).toBe(true);
    });
  });

  describe('renderDashboardFrame', () => {
    it('renders full frame with empty data', () => {
      const frame = renderDashboardFrame(emptyData, WIDTH);
      expect(frame).toContain('AI-SDLC Dashboard');
      expect(frame).toContain('Active Pipelines');
      expect(frame).toContain('Agents');
      expect(frame).toContain('Cost');
    });

    it('renders full frame with fixture data', () => {
      const frame = renderDashboardFrame(fixtureData, WIDTH);
      expect(frame).toContain('code-agent');
      expect(frame).toContain('$12.50');
    });

    it('adapts to different widths', () => {
      const narrow = renderDashboardFrame(fixtureData, 40);
      const wide = renderDashboardFrame(fixtureData, 120);
      // Both should render without errors
      expect(narrow.length).toBeGreaterThan(0);
      expect(wide.length).toBeGreaterThan(0);
    });
  });
});
