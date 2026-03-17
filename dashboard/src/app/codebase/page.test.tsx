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

vi.mock('@/components/charts/heatmap', () => ({
  Heatmap: (props: Record<string, unknown>) => ({
    type: 'mock-heatmap',
    props,
  }),
}));

vi.mock('@/components/graphs/module-graph', () => ({
  ModuleGraph: (props: Record<string, unknown>) => ({
    type: 'mock-module-graph',
    props,
  }),
}));

vi.mock('@/components/tables/data-table', () => ({
  DataTable: (props: Record<string, unknown>) => ({
    type: 'mock-data-table',
    props,
  }),
}));

describe('CodebasePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with empty data', async () => {
    mockAll.mockReturnValueOnce([]); // profiles
    mockAll.mockReturnValueOnce([]); // hotspots

    const { default: CodebasePage } = await import('./page');
    const result = CodebasePage();
    expect(result).toBeTruthy();
    expect(result.type).toBe('div');
  });

  it('renders with profile and hotspot data', async () => {
    mockAll.mockReturnValueOnce([
      {
        repo_path: '/project',
        score: 7.5,
        files_count: 120,
        modules_count: 10,
        dependency_count: 45,
        analyzed_at: '2026-03-15',
        module_graph: null,
      },
    ]);
    mockAll.mockReturnValueOnce([
      {
        file_path: 'src/core/engine.ts',
        churn_rate: 8.5,
        complexity: 15,
        commit_count: 42,
        last_modified: '2026-03-14',
      },
    ]);

    const { default: CodebasePage } = await import('./page');
    const result = CodebasePage();
    expect(result).toBeTruthy();
  });

  it('parses module_graph JSON for visualization', async () => {
    const moduleGraph = JSON.stringify({
      modules: [
        { name: 'core', type: 'library' },
        { name: 'ui', type: 'app' },
      ],
      edges: [{ from: 'ui', to: 'core' }],
    });

    mockAll.mockReturnValueOnce([
      {
        repo_path: '/project',
        score: 5,
        files_count: 50,
        modules_count: 2,
        dependency_count: 10,
        analyzed_at: '2026-03-15',
        module_graph: moduleGraph,
      },
    ]);
    mockAll.mockReturnValueOnce([]);

    const { default: CodebasePage } = await import('./page');
    const result = CodebasePage();
    expect(result).toBeTruthy();
  });

  it('handles invalid module_graph JSON gracefully', async () => {
    mockAll.mockReturnValueOnce([
      {
        repo_path: '/project',
        score: 5,
        files_count: 50,
        modules_count: 2,
        dependency_count: 10,
        analyzed_at: '2026-03-15',
        module_graph: 'not-valid-json{{{',
      },
    ]);
    mockAll.mockReturnValueOnce([]);

    const { default: CodebasePage } = await import('./page');
    const result = CodebasePage();
    expect(result).toBeTruthy();
  });

  it('handles long file paths in hotspots', async () => {
    mockAll.mockReturnValueOnce([]);
    mockAll.mockReturnValueOnce([
      {
        file_path: 'src/very/long/path/to/a/deeply/nested/directory/structure/file.ts',
        churn_rate: 3.2,
        complexity: 10,
        commit_count: 20,
        last_modified: '2026-03-14',
      },
    ]);

    const { default: CodebasePage } = await import('./page');
    const result = CodebasePage();
    expect(result).toBeTruthy();
  });
});
