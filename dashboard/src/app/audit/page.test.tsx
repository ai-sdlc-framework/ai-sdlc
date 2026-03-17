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

vi.mock('@/components/tables/audit-table', () => ({
  AuditTable: (props: Record<string, unknown>) => ({
    type: 'mock-audit-table',
    props,
  }),
}));

describe('AuditPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with empty data', async () => {
    // entries query
    mockAll.mockReturnValueOnce([]);
    // stats query
    mockGet.mockReturnValueOnce({ total: 0, completed: 0, failed: 0, agents: 0 });

    const { default: AuditPage } = await import('./page');
    const result = AuditPage();
    expect(result).toBeTruthy();
    expect(result.type).toBe('div');
  });

  it('renders with audit entries', async () => {
    mockAll.mockReturnValueOnce([
      {
        id: 1,
        run_id: 'run-1',
        issue_number: 42,
        pipeline_type: 'feature',
        status: 'completed',
        agent_name: 'dev',
        cost_usd: 0.5,
        started_at: '2026-03-15',
        completed_at: '2026-03-15',
        gate_results: '{"lint":"pass"}',
      },
    ]);
    mockGet.mockReturnValueOnce({ total: 10, completed: 8, failed: 2, agents: 3 });

    const { default: AuditPage } = await import('./page');
    const result = AuditPage();
    expect(result).toBeTruthy();
  });

  it('handles null stats gracefully', async () => {
    mockAll.mockReturnValueOnce([]);
    mockGet.mockReturnValueOnce({ total: null, completed: null, failed: null, agents: null });

    const { default: AuditPage } = await import('./page');
    const result = AuditPage();
    expect(result).toBeTruthy();
  });
});
