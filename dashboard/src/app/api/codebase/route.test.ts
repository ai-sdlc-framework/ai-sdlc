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

describe('GET /api/codebase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns profiles and hotspots arrays', async () => {
    mockAll.mockReturnValue([]);

    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: { profiles: unknown[]; hotspots: unknown[] } })
      ._data;

    expect(data.profiles).toEqual([]);
    expect(data.hotspots).toEqual([]);
  });

  it('maps profile rows correctly', async () => {
    mockAll
      .mockReturnValueOnce([
        {
          repo_path: '/home/user/project',
          score: 7.5,
          files_count: 120,
          modules_count: 10,
          dependency_count: 45,
          analyzed_at: '2026-03-15T10:00:00Z',
        },
      ])
      .mockReturnValueOnce([]); // hotspots

    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: { profiles: Record<string, unknown>[] } })._data;

    expect(data.profiles).toHaveLength(1);
    expect(data.profiles[0]).toEqual({
      repoPath: '/home/user/project',
      score: 7.5,
      filesCount: 120,
      modulesCount: 10,
      dependencyCount: 45,
      analyzedAt: '2026-03-15T10:00:00Z',
    });
  });

  it('maps hotspot rows correctly', async () => {
    mockAll
      .mockReturnValueOnce([]) // profiles
      .mockReturnValueOnce([
        {
          file_path: 'src/core/engine.ts',
          churn_rate: 8.5,
          complexity: 15,
          commit_count: 42,
          last_modified: '2026-03-14',
        },
      ]);

    const { GET } = await import('./route');
    const response = await GET();
    const data = (response as unknown as { _data: { hotspots: Record<string, unknown>[] } })._data;

    expect(data.hotspots).toHaveLength(1);
    expect(data.hotspots[0]).toEqual({
      filePath: 'src/core/engine.ts',
      churnRate: 8.5,
      complexity: 15,
      commitCount: 42,
      lastModified: '2026-03-14',
    });
  });

  it('handles null optional fields with defaults', async () => {
    mockAll
      .mockReturnValueOnce([
        {
          repo_path: '/project',
          score: 5,
          files_count: null,
          modules_count: null,
          dependency_count: null,
          analyzed_at: undefined,
        },
      ])
      .mockReturnValueOnce([
        {
          file_path: 'file.ts',
          churn_rate: 1,
          complexity: 2,
          commit_count: null,
          last_modified: undefined,
        },
      ]);

    const { GET } = await import('./route');
    const response = await GET();
    const data = (
      response as unknown as {
        _data: { profiles: Record<string, unknown>[]; hotspots: Record<string, unknown>[] };
      }
    )._data;

    expect(data.profiles[0]).toMatchObject({
      filesCount: 0,
      modulesCount: 0,
      dependencyCount: 0,
    });
    expect(data.hotspots[0]).toMatchObject({
      commitCount: 0,
    });
  });
});
