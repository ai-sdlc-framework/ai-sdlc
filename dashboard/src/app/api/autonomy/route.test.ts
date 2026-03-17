import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAll = vi.fn((): Record<string, unknown>[] => {
  return [];
});

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

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown) => ({ _data: data }),
  },
}));

describe('GET /api/autonomy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns agents and events arrays', async () => {
    mockAll.mockReturnValue([]);

    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: { agents: unknown[]; events: unknown[] } })._data;

    expect(data.agents).toEqual([]);
    expect(data.events).toEqual([]);
  });

  it('maps agent rows correctly', async () => {
    mockAll
      .mockReturnValueOnce([
        {
          agent_name: 'dev',
          current_level: 3,
          total_tasks: 100,
          success_count: 85,
          failure_count: 15,
          pr_approval_rate: 0.92,
          rollback_count: 2,
          time_at_level_ms: 86400000,
        },
      ])
      .mockReturnValueOnce([]); // events

    const { GET } = await import('./route');
    const response = await GET();
    const data = (
      response as unknown as { _data: { agents: Record<string, unknown>[]; events: unknown[] } }
    )._data;

    expect(data.agents).toHaveLength(1);
    expect(data.agents[0]).toEqual({
      agentName: 'dev',
      currentLevel: 3,
      totalTasks: 100,
      successRate: 0.85,
      prApprovalRate: 0.92,
      rollbackCount: 2,
      timeAtLevelMs: 86400000,
    });
  });

  it('maps event rows correctly', async () => {
    mockAll
      .mockReturnValueOnce([]) // agents
      .mockReturnValueOnce([
        {
          agent_name: 'dev',
          event_type: 'promotion',
          from_level: 1,
          to_level: 2,
          trigger: 'threshold_met',
          created_at: '2026-03-15T10:00:00Z',
        },
      ]);

    const { GET } = await import('./route');
    const response = await GET();
    const data = (
      response as unknown as { _data: { agents: unknown[]; events: Record<string, unknown>[] } }
    )._data;

    expect(data.events).toHaveLength(1);
    expect(data.events[0]).toEqual({
      agentName: 'dev',
      eventType: 'promotion',
      fromLevel: 1,
      toLevel: 2,
      trigger: 'threshold_met',
      createdAt: '2026-03-15T10:00:00Z',
    });
  });

  it('computes 0 success rate when total_tasks is 0', async () => {
    mockAll
      .mockReturnValueOnce([
        {
          agent_name: 'new',
          current_level: 0,
          total_tasks: 0,
          success_count: 0,
          failure_count: 0,
          pr_approval_rate: null,
          rollback_count: 0,
          time_at_level_ms: 0,
        },
      ])
      .mockReturnValueOnce([]);

    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: { agents: Record<string, unknown>[] } })._data;

    expect(data.agents[0]).toMatchObject({
      successRate: 0,
      prApprovalRate: null,
    });
  });
});
