import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('@/lib/state', () => ({
  getStateStore: () => ({
    getDatabase: () => ({
      prepare: () => ({
        all: vi.fn(),
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

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns healthy status when no failures', async () => {
    // Three .get() calls: totals, last24h, agents
    mockGet
      .mockReturnValueOnce({ total: 50 }) // totals
      .mockReturnValueOnce({ total: 10, failed: 0 }) // last24h
      .mockReturnValueOnce({ count: 3 }); // agents

    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: Record<string, unknown> })._data;
    expect(data.status).toBe('healthy');
    expect(data.runsTotal).toBe(50);
    expect(data.runsLast24h).toBe(10);
    expect(data.failureRate24h).toBe(0);
    expect(data.activeAgents).toBe(3);
  });

  it('returns degraded when failure rate > 0.2', async () => {
    mockGet
      .mockReturnValueOnce({ total: 100 })
      .mockReturnValueOnce({ total: 10, failed: 3 }) // 30% failure rate
      .mockReturnValueOnce({ count: 2 });

    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: Record<string, unknown> })._data;
    expect(data.status).toBe('degraded');
    expect(data.failureRate24h).toBeCloseTo(0.3);
  });

  it('returns unhealthy when failure rate > 0.5', async () => {
    mockGet
      .mockReturnValueOnce({ total: 100 })
      .mockReturnValueOnce({ total: 10, failed: 6 }) // 60% failure rate
      .mockReturnValueOnce({ count: 1 });

    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: Record<string, unknown> })._data;
    expect(data.status).toBe('unhealthy');
    expect(data.failureRate24h).toBeCloseTo(0.6);
  });

  it('returns healthy when no runs in last 24h', async () => {
    mockGet
      .mockReturnValueOnce({ total: 0 })
      .mockReturnValueOnce({ total: 0, failed: 0 })
      .mockReturnValueOnce({ count: 0 });

    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: Record<string, unknown> })._data;
    expect(data.status).toBe('healthy');
    expect(data.failureRate24h).toBe(0);
  });
});
