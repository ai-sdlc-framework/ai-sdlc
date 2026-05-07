/**
 * DepsFullScreen tests — RFC-0023 §7.6 / AISDLC-178.5.
 *
 * Drives the component with injected rows so we don't need a snapshot file
 * on disk.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';

import { DepsFullScreen } from './deps-full.js';
import type { SnapshotRecord } from '../../deps/snapshot.js';

// Mock useCriticalPath so the live hook doesn't fire fs reads.
vi.mock('../critical-path/use-critical-path.js', async () => {
  const actual = await vi.importActual<typeof import('../critical-path/use-critical-path.js')>(
    '../critical-path/use-critical-path.js',
  );
  return {
    ...actual,
    useCriticalPath: () => ({
      rows: [],
      allRecords: [],
      error: null,
      lastFetched: null,
      refresh: () => {},
    }),
  };
});

afterEach(() => {
  cleanup();
});

const RECORDS: SnapshotRecord[] = [
  {
    id: 'AISDLC-1',
    dependencies: [],
    dependents: ['AISDLC-2'],
    criticalPathLength: 2,
    effectivePriority: 3,
  } as unknown as SnapshotRecord,
  {
    id: 'AISDLC-2',
    dependencies: ['AISDLC-1'],
    dependents: [],
    criticalPathLength: 0,
    effectivePriority: 1,
  } as unknown as SnapshotRecord,
];

describe('DepsFullScreen', () => {
  it('renders the dep graph header with the task count', () => {
    const { lastFrame } = render(
      <DepsFullScreen rows={RECORDS.map((record) => ({ record }))} allRecords={RECORDS} />,
    );
    expect(lastFrame() ?? '').toContain('DEPENDENCY GRAPH (2 tasks)');
  });

  it('renders each task ID + tree info', () => {
    const { lastFrame } = render(
      <DepsFullScreen rows={RECORDS.map((record) => ({ record }))} allRecords={RECORDS} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('AISDLC-1');
    expect(frame).toContain('AISDLC-2');
  });

  it('filters by query when filterQuery is set', () => {
    const { lastFrame } = render(
      <DepsFullScreen
        rows={RECORDS.map((record) => ({ record }))}
        allRecords={RECORDS}
        filterQuery="2"
      />,
    );
    const frame = lastFrame() ?? '';
    // After filtering only one row remains as the focused header.
    expect(frame).toContain('DEPENDENCY GRAPH (1 tasks)');
    expect(frame).toContain('AISDLC-2');
  });

  it('shows empty-state hint when there are no rows', () => {
    const { lastFrame } = render(<DepsFullScreen rows={[]} allRecords={[]} />);
    expect(lastFrame() ?? '').toContain('No dep snapshot found');
  });

  it('shows no-match hint when filter excludes everything', () => {
    const { lastFrame } = render(
      <DepsFullScreen
        rows={RECORDS.map((record) => ({ record }))}
        allRecords={RECORDS}
        filterQuery="zzz"
      />,
    );
    expect(lastFrame() ?? '').toContain('No tasks match "zzz"');
  });

  it('renders the back-to-overview hint', () => {
    const { lastFrame } = render(
      <DepsFullScreen rows={RECORDS.map((record) => ({ record }))} allRecords={RECORDS} />,
    );
    expect(lastFrame() ?? '').toContain('back to overview');
  });
});
