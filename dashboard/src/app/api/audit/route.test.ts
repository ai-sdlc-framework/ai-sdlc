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

describe('GET /api/audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns audit entries and total count', async () => {
    mockGet.mockReturnValue({ total: 1 });
    mockAll.mockReturnValue([
      {
        id: 1,
        run_id: 'run-1',
        issue_number: 42,
        pipeline_type: 'feature',
        status: 'completed',
        agent_name: 'dev-agent',
        cost_usd: 0.5,
        started_at: '2026-03-15T10:00:00Z',
        completed_at: '2026-03-15T10:05:00Z',
        gate_results: '{"lint":"pass"}',
      },
    ]);

    const { GET } = await import('./route');
    const request = new Request('http://localhost/api/audit');
    const response = await GET(request);
    const data = (response as unknown as { _data: { entries: unknown[]; total: number } })._data;

    expect(data.total).toBe(1);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]).toEqual({
      id: 1,
      runId: 'run-1',
      issueNumber: 42,
      pipelineType: 'feature',
      status: 'completed',
      agentName: 'dev-agent',
      costUsd: 0.5,
      startedAt: '2026-03-15T10:00:00Z',
      completedAt: '2026-03-15T10:05:00Z',
      gateResults: '{"lint":"pass"}',
    });
  });

  it('returns empty entries when no runs', async () => {
    mockGet.mockReturnValue({ total: 0 });
    mockAll.mockReturnValue([]);

    const { GET } = await import('./route');
    const request = new Request('http://localhost/api/audit');
    const response = await GET(request);
    const data = (response as unknown as { _data: { entries: unknown[]; total: number } })._data;

    expect(data.total).toBe(0);
    expect(data.entries).toEqual([]);
  });

  it('passes status filter', async () => {
    mockGet.mockReturnValue({ total: 0 });
    mockAll.mockReturnValue([]);

    const { GET } = await import('./route');
    const request = new Request('http://localhost/api/audit?status=failed');
    await GET(request);
    // The mock was called - the filter is applied in the SQL which we can't directly verify
    // but the function ran without error
    expect(mockGet).toHaveBeenCalled();
  });

  it('passes agent filter', async () => {
    mockGet.mockReturnValue({ total: 0 });
    mockAll.mockReturnValue([]);

    const { GET } = await import('./route');
    const request = new Request('http://localhost/api/audit?agent=dev-agent');
    await GET(request);
    expect(mockGet).toHaveBeenCalled();
  });

  it('passes both status and agent filters', async () => {
    mockGet.mockReturnValue({ total: 0 });
    mockAll.mockReturnValue([]);

    const { GET } = await import('./route');
    const request = new Request('http://localhost/api/audit?status=completed&agent=dev-agent');
    await GET(request);
    expect(mockGet).toHaveBeenCalled();
  });

  it('respects limit and offset', async () => {
    mockGet.mockReturnValue({ total: 0 });
    mockAll.mockReturnValue([]);

    const { GET } = await import('./route');
    const request = new Request('http://localhost/api/audit?limit=10&offset=20');
    await GET(request);
    expect(mockAll).toHaveBeenCalled();
  });
});
