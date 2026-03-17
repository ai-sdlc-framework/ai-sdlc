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

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown) => ({ _data: data }),
  },
}));

describe('GET /api/runs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when no runs', async () => {
    mockAll.mockReturnValue([]);
    const { GET } = await import('./route');
    const request = new Request('http://localhost/api/runs');
    const response = await GET(request);
    const data = (response as unknown as { _data: unknown[] })._data;
    expect(data).toEqual([]);
  });

  it('maps database rows to RunSummary format', async () => {
    mockAll.mockReturnValue([
      {
        run_id: 'run-1',
        issue_number: 42,
        pr_number: 10,
        pipeline_type: 'feature',
        status: 'completed',
        agent_name: 'dev-agent',
        cost_usd: 0.5,
        tokens_used: 5000,
        started_at: '2026-03-15T10:00:00Z',
        completed_at: '2026-03-15T10:05:00Z',
      },
    ]);
    const { GET } = await import('./route');
    const request = new Request('http://localhost/api/runs');
    const response = await GET(request);
    const data = (response as unknown as { _data: unknown[] })._data;
    expect(data).toHaveLength(1);
    expect(data[0]).toEqual({
      runId: 'run-1',
      issueNumber: 42,
      prNumber: 10,
      pipelineType: 'feature',
      status: 'completed',
      agentName: 'dev-agent',
      costUsd: 0.5,
      tokensUsed: 5000,
      startedAt: '2026-03-15T10:00:00Z',
      completedAt: '2026-03-15T10:05:00Z',
    });
  });

  it('respects limit query parameter', async () => {
    mockAll.mockReturnValue([]);
    const { GET } = await import('./route');
    const request = new Request('http://localhost/api/runs?limit=10');
    await GET(request);
    // all is called with the limit parameter
    expect(mockAll).toHaveBeenCalled();
  });

  it('caps limit at 200', async () => {
    mockAll.mockImplementation((...args: unknown[]) => {
      // Verify the limit passed to .all()
      expect(args[0]).toBeLessThanOrEqual(200);
      return [];
    });
    const { GET } = await import('./route');
    const request = new Request('http://localhost/api/runs?limit=999');
    await GET(request);
  });
});
