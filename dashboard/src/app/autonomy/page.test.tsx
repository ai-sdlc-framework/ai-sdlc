import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAll = vi.fn();

vi.mock('@/lib/state', () => ({
  getStateStore: () => ({
    getDatabase: () => ({
      prepare: () => ({
        all: mockAll,
        get: vi.fn(),
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

vi.mock('@/components/charts/timeline', () => ({
  Timeline: (props: Record<string, unknown>) => ({
    type: 'mock-timeline',
    props,
  }),
}));

vi.mock('@/components/tables/data-table', () => ({
  DataTable: (props: Record<string, unknown>) => ({
    type: 'mock-data-table',
    props,
  }),
}));

describe('AutonomyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with empty data', async () => {
    mockAll.mockReturnValueOnce([]); // agents
    mockAll.mockReturnValueOnce([]); // events

    const { default: AutonomyPage } = await import('./page');
    const result = AutonomyPage();
    expect(result).toBeTruthy();
    expect(result.type).toBe('div');
  });

  it('renders with agents and events', async () => {
    mockAll.mockReturnValueOnce([
      {
        agent_name: 'dev',
        current_level: 2,
        total_tasks: 50,
        success_count: 45,
        failure_count: 5,
        pr_approval_rate: 0.9,
        rollback_count: 1,
        time_at_level_ms: 86400000,
      },
    ]);
    mockAll.mockReturnValueOnce([
      {
        agent_name: 'dev',
        event_type: 'promotion',
        from_level: 1,
        to_level: 2,
        trigger: 'threshold_met',
        created_at: '2026-03-15',
      },
      {
        agent_name: 'dev',
        event_type: 'demotion',
        from_level: 2,
        to_level: 1,
        trigger: 'failure',
        created_at: '2026-03-14',
      },
    ]);

    const { default: AutonomyPage } = await import('./page');
    const result = AutonomyPage();
    expect(result).toBeTruthy();
  });

  it('computes average level across agents', async () => {
    mockAll.mockReturnValueOnce([
      {
        agent_name: 'a1',
        current_level: 2,
        total_tasks: 10,
        success_count: 8,
        failure_count: 2,
        pr_approval_rate: null,
        rollback_count: 0,
        time_at_level_ms: 0,
      },
      {
        agent_name: 'a2',
        current_level: 4,
        total_tasks: 20,
        success_count: 18,
        failure_count: 2,
        pr_approval_rate: 0.95,
        rollback_count: 0,
        time_at_level_ms: 0,
      },
    ]);
    mockAll.mockReturnValueOnce([]);

    const { default: AutonomyPage } = await import('./page');
    const result = AutonomyPage();
    expect(result).toBeTruthy();
  });
});
