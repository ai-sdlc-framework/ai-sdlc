import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock state module
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

// Mock next/server
vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown) => ({ json: () => data, _data: data }),
  },
}));

describe('GET /api/agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when no agents', async () => {
    mockAll.mockReturnValue([]);
    const { GET } = await import('./route');
    const response = await GET();
    expect((response as unknown as { _data: unknown[] })._data).toEqual([]);
  });

  it('maps database rows to AgentSummary format', async () => {
    mockAll.mockReturnValue([
      {
        agent_name: 'dev-agent',
        current_level: 2,
        total_tasks: 100,
        success_count: 90,
        failure_count: 10,
        last_task_at: '2026-03-15T10:00:00Z',
      },
    ]);
    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: unknown[] })._data;
    expect(data).toHaveLength(1);
    expect(data[0]).toEqual({
      agentName: 'dev-agent',
      currentLevel: 2,
      totalTasks: 100,
      successRate: 0.9,
      lastTaskAt: '2026-03-15T10:00:00Z',
    });
  });

  it('handles zero total tasks with 0 success rate', async () => {
    mockAll.mockReturnValue([
      {
        agent_name: 'new-agent',
        current_level: 0,
        total_tasks: 0,
        success_count: 0,
        failure_count: 0,
        last_task_at: undefined,
      },
    ]);
    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: unknown[] })._data;
    expect(data[0]).toMatchObject({
      agentName: 'new-agent',
      successRate: 0,
    });
  });

  it('handles multiple agents', async () => {
    mockAll.mockReturnValue([
      {
        agent_name: 'a1',
        current_level: 1,
        total_tasks: 50,
        success_count: 40,
        failure_count: 10,
        last_task_at: null,
      },
      {
        agent_name: 'a2',
        current_level: 3,
        total_tasks: 200,
        success_count: 195,
        failure_count: 5,
        last_task_at: '2026-03-16',
      },
    ]);
    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: unknown[] })._data;
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ agentName: 'a1', successRate: 0.8 });
    expect(data[1]).toMatchObject({ agentName: 'a2', successRate: 0.975 });
  });
});
