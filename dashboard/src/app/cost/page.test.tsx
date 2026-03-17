import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAll = vi.fn();
const mockGet = vi.fn();

vi.mock('@/lib/state', () => ({
  getStateStore: () => ({
    getDatabase: () => ({
      prepare: () => ({
        all: mockAll,
        get: mockGet,
      }),
    }),
  }),
}));

vi.mock('@/components/layout/header', () => ({
  Header: ({ title, subtitle }: { title: string; subtitle?: string }) => ({
    type: 'mock-header',
    props: { title, subtitle },
  }),
}));

vi.mock('@/components/cards/stat-card', () => ({
  StatCard: (props: Record<string, unknown>) => ({
    type: 'mock-stat-card',
    props,
  }),
}));

vi.mock('@/components/charts/bar-chart', () => ({
  BarChart: (props: Record<string, unknown>) => ({
    type: 'mock-bar-chart',
    props,
  }),
}));

vi.mock('@/components/charts/line-chart', () => ({
  LineChart: (props: Record<string, unknown>) => ({
    type: 'mock-line-chart',
    props,
  }),
}));

describe('CostPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with empty data', async () => {
    mockGet.mockReturnValueOnce({ total_cost: 0, total_tokens: 0, run_count: 0 }); // totals
    mockAll.mockReturnValueOnce([]); // byAgent
    mockAll.mockReturnValueOnce([]); // byModel
    mockAll.mockReturnValueOnce([]); // timeSeries

    const { default: CostPage } = await import('./page');
    const result = CostPage();
    expect(result).toBeTruthy();
    expect(result.type).toBe('div');
  });

  it('renders with cost data', async () => {
    mockGet.mockReturnValueOnce({ total_cost: 250, total_tokens: 500000, run_count: 50 });
    mockAll.mockReturnValueOnce([
      { agent_name: 'dev-agent', cost_usd: 200, runs: 40 },
      { agent_name: 'review-agent', cost_usd: 50, runs: 10 },
    ]);
    mockAll.mockReturnValueOnce([{ model: 'claude-sonnet-4-5-20250929', cost_usd: 200, runs: 40 }]);
    mockAll.mockReturnValueOnce([
      { date: '2026-03-14', cost_usd: 10, runs: 5 },
      { date: '2026-03-15', cost_usd: 15, runs: 8 },
    ]);

    const { default: CostPage } = await import('./page');
    const result = CostPage();
    expect(result).toBeTruthy();
  });

  it('renders BudgetGauge with over-budget state', async () => {
    mockGet.mockReturnValueOnce({ total_cost: 600, total_tokens: 1000000, run_count: 100 });
    mockAll.mockReturnValueOnce([{ agent_name: 'dev', cost_usd: 600, runs: 100 }]);
    mockAll.mockReturnValueOnce([]);
    mockAll.mockReturnValueOnce([]);

    const { default: CostPage } = await import('./page');
    const result = CostPage();
    expect(result).toBeTruthy();
  });

  it('renders BudgetGauge under 80% utilization', async () => {
    mockGet.mockReturnValueOnce({ total_cost: 100, total_tokens: 200000, run_count: 20 });
    mockAll.mockReturnValueOnce([]);
    mockAll.mockReturnValueOnce([]);
    mockAll.mockReturnValueOnce([]);

    const { default: CostPage } = await import('./page');
    const result = CostPage();
    expect(result).toBeTruthy();
  });

  it('renders BudgetGauge between 80-100% utilization', async () => {
    mockGet.mockReturnValueOnce({ total_cost: 450, total_tokens: 900000, run_count: 80 });
    mockAll.mockReturnValueOnce([]);
    mockAll.mockReturnValueOnce([]);
    mockAll.mockReturnValueOnce([]);

    const { default: CostPage } = await import('./page');
    const result = CostPage();
    expect(result).toBeTruthy();
  });
});
