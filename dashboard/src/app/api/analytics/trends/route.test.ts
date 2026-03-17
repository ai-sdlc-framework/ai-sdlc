import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/state', () => ({
  getStateStore: () => ({
    getDatabase: () => ({}),
  }),
}));

describe('GET /api/analytics/trends', () => {
  it('returns 404 when enterprise package is not installed', async () => {
    const { GET } = await import('./route');
    const response = await GET();
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Enterprise feature not available');
  });
});
