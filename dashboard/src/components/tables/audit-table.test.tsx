import { describe, it, expect } from 'vitest';
import { AuditTable } from './audit-table';
import type { AuditEntry } from '@/app/api/audit/route';

describe('AuditTable', () => {
  it('renders empty state', () => {
    const result = AuditTable({ entries: [] });
    expect(result).toBeTruthy();
  });

  it('renders entries', () => {
    const entries: AuditEntry[] = [
      {
        id: 1,
        runId: 'abc12345',
        issueNumber: 42,
        pipelineType: 'feature',
        status: 'completed',
        agentName: 'dev',
        costUsd: 0.15,
        startedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 2,
        runId: 'def67890',
        pipelineType: 'fix-ci',
        status: 'failed',
        startedAt: '2026-01-02T00:00:00Z',
      },
    ];
    const result = AuditTable({ entries });
    expect(result).toBeTruthy();
  });

  it('handles missing optional fields', () => {
    const entries: AuditEntry[] = [
      {
        id: 3,
        runId: 'min-entry',
        pipelineType: 'bugfix',
        status: 'pending',
      },
    ];
    const result = AuditTable({ entries });
    expect(result).toBeTruthy();
  });
});
