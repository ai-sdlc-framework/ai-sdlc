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

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown) => ({ _data: data }),
  },
}));

describe('GET /api/cost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cost summary with empty data', async () => {
    // totals
    mockGet.mockReturnValueOnce({ total_cost: 0, total_tokens: 0, run_count: 0 });
    // byAgent
    mockAll.mockReturnValueOnce([]);
    // byModel
    mockAll.mockReturnValueOnce([]);
    // timeSeries
    mockAll.mockReturnValueOnce([]);
    // dateRange
    mockGet.mockReturnValueOnce({ first_at: null, last_at: null });

    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: Record<string, unknown> })._data;

    expect(data.totalCostUsd).toBe(0);
    expect(data.totalTokens).toBe(0);
    expect(data.runCount).toBe(0);
    expect(data.byAgent).toEqual([]);
    expect(data.timeSeries).toEqual([]);
    expect(data.byModel).toEqual([]);
  });

  it('computes budget correctly', async () => {
    mockGet.mockReturnValueOnce({ total_cost: 250, total_tokens: 500000, run_count: 50 });
    mockAll.mockReturnValueOnce([{ agent_name: 'dev', cost_usd: 250, runs: 50 }]);
    mockAll.mockReturnValueOnce([{ model: 'claude-sonnet', cost_usd: 250, runs: 50 }]);
    mockAll.mockReturnValueOnce([{ date: '2026-03-15', cost_usd: 10, runs: 5 }]);
    mockGet.mockReturnValueOnce({
      first_at: '2026-03-01T00:00:00Z',
      last_at: '2026-03-15T00:00:00Z',
    });

    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: Record<string, unknown> })._data;

    expect(data.totalCostUsd).toBe(250);
    const budget = data.budget as Record<string, unknown>;
    expect(budget.budgetUsd).toBe(500);
    expect(budget.spentUsd).toBe(250);
    expect(budget.remainingUsd).toBe(250);
    expect(budget.utilizationPercent).toBe(50);
    expect(budget.overBudget).toBe(false);
    expect(budget.projectedMonthlyUsd).toBeGreaterThan(0);
  });

  it('detects over budget', async () => {
    mockGet.mockReturnValueOnce({ total_cost: 600, total_tokens: 1000000, run_count: 100 });
    mockAll.mockReturnValueOnce([]);
    mockAll.mockReturnValueOnce([]);
    mockAll.mockReturnValueOnce([]);
    mockGet.mockReturnValueOnce({ first_at: '2026-03-01', last_at: '2026-03-15' });

    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: Record<string, unknown> })._data;

    const budget = data.budget as Record<string, unknown>;
    expect(budget.overBudget).toBe(true);
    expect(budget.remainingUsd).toBe(0);
  });

  it('maps byAgent correctly', async () => {
    mockGet.mockReturnValueOnce({ total_cost: 10, total_tokens: 20000, run_count: 5 });
    mockAll.mockReturnValueOnce([
      { agent_name: 'dev', cost_usd: 8, runs: 4 },
      { agent_name: 'review', cost_usd: 2, runs: 1 },
    ]);
    mockAll.mockReturnValueOnce([]);
    mockAll.mockReturnValueOnce([]);
    mockGet.mockReturnValueOnce({ first_at: null, last_at: null });

    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: Record<string, unknown> })._data;

    const byAgent = data.byAgent as Array<Record<string, unknown>>;
    expect(byAgent).toHaveLength(2);
    expect(byAgent[0]).toEqual({ agentName: 'dev', costUsd: 8, runs: 4 });
    expect(byAgent[1]).toEqual({ agentName: 'review', costUsd: 2, runs: 1 });
  });

  it('handles projectedMonthlyUsd as 0 when no date range', async () => {
    mockGet.mockReturnValueOnce({ total_cost: 100, total_tokens: 200000, run_count: 20 });
    mockAll.mockReturnValueOnce([]);
    mockAll.mockReturnValueOnce([]);
    mockAll.mockReturnValueOnce([]);
    mockGet.mockReturnValueOnce({ first_at: null, last_at: null });

    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: Record<string, unknown> })._data;

    const budget = data.budget as Record<string, unknown>;
    expect(budget.projectedMonthlyUsd).toBe(0);
  });
});
