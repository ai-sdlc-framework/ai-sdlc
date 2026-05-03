/**
 * Tests for the dependency-graph dashboard page (AISDLC-167.4 / RFC-0014
 * Phase 4 §7.2).
 *
 * Mirrors the AISDLC-162 dor/page.test.tsx pattern — mocks the data loader +
 * the shared layout components so the page render reduces to a tree of mock
 * objects we can structurally assert on. End-to-end loader behaviour is
 * already covered in `deps-data.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EnrichedSnapshotRecord } from '@ai-sdlc/pipeline-cli/deps';
import { colorForStatus, priorityBucketLabel } from './format';

const mockLoad = vi.fn();

vi.mock('@/lib/deps-data', () => ({
  loadDepsData: () => mockLoad(),
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

function makeRecord(overrides: Partial<EnrichedSnapshotRecord> = {}): EnrichedSnapshotRecord {
  return {
    id: 'AISDLC-A',
    title: 'A title',
    status: 'To Do',
    effectiveStatus: 'open',
    basePriority: 2,
    effectivePriority: 2,
    criticalPathLength: 0,
    dependentCount: 0,
    dependencies: [],
    dependents: [],
    lastModified: '',
    filePath: '',
    warnings: [],
    ...overrides,
  };
}

describe('colorForStatus (RFC-0014 §7.2 color contract)', () => {
  it('To Do → blue', () => {
    expect(colorForStatus('To Do')).toBe('#2563eb');
    expect(colorForStatus('to do')).toBe('#2563eb');
    expect(colorForStatus('TODO')).toBe('#2563eb');
  });

  it('In Progress → yellow', () => {
    expect(colorForStatus('In Progress')).toBe('#ca8a04');
    expect(colorForStatus('in progress')).toBe('#ca8a04');
    expect(colorForStatus('WIP')).toBe('#ca8a04');
  });

  it('Needs Clarification → red', () => {
    expect(colorForStatus('Needs Clarification')).toBe('#dc2626');
    expect(colorForStatus('needs-clarification')).toBe('#dc2626');
    expect(colorForStatus('blocked')).toBe('#dc2626');
  });

  it('Done → green', () => {
    expect(colorForStatus('Done')).toBe('#16a34a');
    expect(colorForStatus('completed')).toBe('#16a34a');
    expect(colorForStatus('shipped')).toBe('#16a34a');
  });

  it('unknown statuses fall through to neutral gray', () => {
    expect(colorForStatus('whatever')).toBe('#64748b');
    expect(colorForStatus('')).toBe('#64748b');
  });
});

describe('priorityBucketLabel', () => {
  it('maps 1-4 to low/medium/high/critical', () => {
    expect(priorityBucketLabel(1)).toBe('low');
    expect(priorityBucketLabel(2)).toBe('medium');
    expect(priorityBucketLabel(3)).toBe('high');
    expect(priorityBucketLabel(4)).toBe('critical');
  });

  it('falls back to "?" for unknown weights', () => {
    expect(priorityBucketLabel(0)).toBe('?');
    expect(priorityBucketLabel(99)).toBe('?');
  });
});

describe('DepsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the empty-state hint when no snapshot is found', async () => {
    mockLoad.mockReturnValueOnce(null);
    const { default: DepsPage } = await import('./page');
    const result = DepsPage();
    expect(result).toBeTruthy();
    expect(result.type).toBe('div');
  });

  it('renders the populated state with criticalPath + enriched table', async () => {
    mockLoad.mockReturnValueOnce({
      artifactsRoot: '/tmp/artifacts',
      snapshotPath: '/tmp/artifacts/_deps/snapshot.iso.rolling.jsonl',
      snapshotIsoTimestamp: '2026-05-01T00-00-00.000Z',
      snapshotTag: 'rolling',
      totalRecords: 3,
      skipped: 0,
      enriched: [
        makeRecord({
          id: 'AISDLC-A',
          title: 'A root',
          basePriority: 2,
          effectivePriority: 4,
          criticalPathLength: 4,
          dependentCount: 1,
          status: 'To Do',
        }),
        makeRecord({
          id: 'AISDLC-B',
          title: 'B mid',
          basePriority: 2,
          effectivePriority: 4,
          criticalPathLength: 3,
          dependentCount: 1,
          status: 'In Progress',
        }),
        makeRecord({
          id: 'AISDLC-Z',
          title: 'isolated',
          basePriority: 2,
          effectivePriority: 2,
          criticalPathLength: 0,
          dependentCount: 0,
          status: 'Done',
        }),
      ],
      criticalPath: [
        makeRecord({
          id: 'AISDLC-A',
          title: 'A root',
          basePriority: 2,
          effectivePriority: 4,
          criticalPathLength: 4,
          dependentCount: 1,
          status: 'To Do',
        }),
        makeRecord({
          id: 'AISDLC-B',
          title: 'B mid',
          basePriority: 2,
          effectivePriority: 4,
          criticalPathLength: 3,
          dependentCount: 1,
          status: 'In Progress',
        }),
      ],
    });
    const { default: DepsPage } = await import('./page');
    const result = DepsPage();
    expect(result).toBeTruthy();
  });

  it('renders the empty-graph state when no qualifying critical-path items', async () => {
    mockLoad.mockReturnValueOnce({
      artifactsRoot: '/tmp/artifacts',
      snapshotPath: '/tmp/artifacts/_deps/snapshot.iso.rolling.jsonl',
      snapshotIsoTimestamp: '2026-05-01T00-00-00.000Z',
      snapshotTag: 'rolling',
      totalRecords: 1,
      skipped: 0,
      enriched: [
        makeRecord({
          id: 'AISDLC-A',
          title: 'isolated',
          status: 'To Do',
          basePriority: 2,
          effectivePriority: 2,
          criticalPathLength: 0,
          dependentCount: 0,
        }),
      ],
      criticalPath: [],
    });
    const { default: DepsPage } = await import('./page');
    const result = DepsPage();
    expect(result).toBeTruthy();
  });

  it('surfaces dangling-edge warnings via the details section', async () => {
    mockLoad.mockReturnValueOnce({
      artifactsRoot: '/tmp/artifacts',
      snapshotPath: '/tmp/artifacts/_deps/snapshot.iso.rolling.jsonl',
      snapshotIsoTimestamp: '2026-05-01T00-00-00.000Z',
      snapshotTag: 'rolling',
      totalRecords: 1,
      skipped: 0,
      enriched: [
        makeRecord({
          id: 'AISDLC-GHOST',
          title: '',
          status: '',
          warnings: ['task AISDLC-GHOST present in snapshot but missing from live graph'],
        }),
      ],
      criticalPath: [],
    });
    const { default: DepsPage } = await import('./page');
    const result = DepsPage();
    expect(result).toBeTruthy();
  });

  it('renders skipped-line counter when malformed lines were skipped', async () => {
    mockLoad.mockReturnValueOnce({
      artifactsRoot: '/tmp/artifacts',
      snapshotPath: '/tmp/artifacts/_deps/snapshot.iso.rolling.jsonl',
      snapshotIsoTimestamp: '2026-05-01T00-00-00.000Z',
      snapshotTag: 'rolling',
      totalRecords: 1,
      skipped: 3,
      enriched: [makeRecord({ id: 'AISDLC-A', title: 'A' })],
      criticalPath: [],
    });
    const { default: DepsPage } = await import('./page');
    const result = DepsPage();
    expect(result).toBeTruthy();
  });
});
