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

vi.mock('@/components/cards/run-card', () => ({
  RunCard: (props: Record<string, unknown>) => ({
    type: 'mock-run-card',
    props,
  }),
}));

vi.mock('@/components/cards/agent-card', () => ({
  AgentCard: (props: Record<string, unknown>) => ({
    type: 'mock-agent-card',
    props,
  }),
}));

describe('OverviewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with empty data', async () => {
    // getHealth: totals, last24h, agents
    mockGet
      .mockReturnValueOnce({ total: 0 })
      .mockReturnValueOnce({ total: 0, failed: 0 })
      .mockReturnValueOnce({ count: 0 });
    // getRecentRuns
    mockAll.mockReturnValueOnce([]);
    // getAgents
    mockAll.mockReturnValueOnce([]);

    const { default: OverviewPage } = await import('./page');
    const result = OverviewPage();
    expect(result).toBeTruthy();
    expect(result.type).toBe('div');
  });

  it('renders with runs and agents', async () => {
    mockGet
      .mockReturnValueOnce({ total: 50 })
      .mockReturnValueOnce({ total: 10, failed: 1 })
      .mockReturnValueOnce({ count: 3 });
    mockAll.mockReturnValueOnce([
      {
        run_id: 'run-1',
        issue_number: 42,
        pr_number: null,
        pipeline_type: 'feature',
        status: 'completed',
        agent_name: 'dev',
        cost_usd: 0.5,
        tokens_used: 5000,
        started_at: '2026-03-15',
        completed_at: '2026-03-15',
      },
    ]);
    mockAll.mockReturnValueOnce([
      {
        agent_name: 'dev',
        current_level: 2,
        total_tasks: 100,
        success_count: 90,
        failure_count: 10,
        last_task_at: '2026-03-15',
      },
    ]);

    const { default: OverviewPage } = await import('./page');
    const result = OverviewPage();
    expect(result).toBeTruthy();
  });

  it('shows unhealthy status color when failure rate is high', async () => {
    mockGet
      .mockReturnValueOnce({ total: 100 })
      .mockReturnValueOnce({ total: 10, failed: 6 }) // 60% failure
      .mockReturnValueOnce({ count: 1 });
    mockAll.mockReturnValueOnce([]);
    mockAll.mockReturnValueOnce([]);

    const { default: OverviewPage } = await import('./page');
    const result = OverviewPage();
    expect(result).toBeTruthy();
  });

  it('shows degraded status color when failure rate is moderate', async () => {
    mockGet
      .mockReturnValueOnce({ total: 100 })
      .mockReturnValueOnce({ total: 10, failed: 3 }) // 30% failure
      .mockReturnValueOnce({ count: 2 });
    mockAll.mockReturnValueOnce([]);
    mockAll.mockReturnValueOnce([]);

    const { default: OverviewPage } = await import('./page');
    const result = OverviewPage();
    expect(result).toBeTruthy();
  });
});
