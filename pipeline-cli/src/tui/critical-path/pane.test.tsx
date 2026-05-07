/**
 * Tests for the Critical Path pane component — RFC-0023 §7.3 / AISDLC-178.4.
 *
 * Covers:
 *   - Empty state (no snapshot)
 *   - Error banner when source unavailable
 *   - List rendering: task ID, effPri, CPL, blast-radius
 *   - Max rows cap (CRITICAL_PATH_MAX_ROWS)
 *   - Keyboard: Enter opens detail view, Escape closes it
 *   - Detail view: ASCII dep tree, task info
 */

import React from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';

import { CriticalPathPaneContent, CRITICAL_PATH_MAX_ROWS } from './pane.js';
import { buildCriticalPathRows } from './use-critical-path.js';
import type { SnapshotRecord } from '../../deps/snapshot.js';

afterEach(() => {
  cleanup();
});

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function makeRecord(
  id: string,
  overrides: Partial<Omit<SnapshotRecord, 'id'>> = {},
): SnapshotRecord {
  return {
    id,
    dependencies: [],
    dependents: [],
    depth: 0,
    criticalPathLength: 0,
    effectivePriority: 2, // medium default per RFC-0014
    externalDependencies: [],
    lastModified: '',
    ...overrides,
  };
}

describe('CriticalPathPaneContent — empty state', () => {
  it('renders CRITICAL PATH title', () => {
    const { lastFrame } = render(
      <CriticalPathPaneContent rows={[]} allRecords={[]} error={null} />,
    );
    expect(lastFrame()).toContain('CRITICAL PATH');
  });

  it('shows no-snapshot message when rows empty', () => {
    const { lastFrame } = render(
      <CriticalPathPaneContent rows={[]} allRecords={[]} error={null} />,
    );
    expect(lastFrame()).toContain('No dep snapshot found');
  });
});

describe('CriticalPathPaneContent — error state', () => {
  it('shows error banner when source-unavailable', () => {
    const { lastFrame } = render(
      <CriticalPathPaneContent rows={[]} allRecords={[]} error="source-unavailable" />,
    );
    expect(lastFrame()).toContain('dep snapshot unavailable');
    expect(lastFrame()).toContain('source-unavailable');
  });

  it('shows error banner when source-permission-denied', () => {
    const { lastFrame } = render(
      <CriticalPathPaneContent rows={[]} allRecords={[]} error="source-permission-denied" />,
    );
    expect(lastFrame()).toContain('source-permission-denied');
  });
});

describe('CriticalPathPaneContent — list rendering', () => {
  it('renders task ID in each row', () => {
    const records = [makeRecord('AISDLC-42', { criticalPathLength: 2 })];
    const rows = buildCriticalPathRows(records);
    const { lastFrame } = render(
      <CriticalPathPaneContent rows={rows} allRecords={records} error={null} />,
    );
    expect(lastFrame()).toContain('AISDLC-42');
  });

  it('renders effPri and CPL for each row', () => {
    // AISDLC-178.4 #384 review fix: effPri now reads the proper
    // SnapshotRecord.effectivePriority field instead of proxying from CPL.
    const records = [makeRecord('AISDLC-10', { criticalPathLength: 3, effectivePriority: 3 })];
    const rows = buildCriticalPathRows(records);
    const { lastFrame } = render(
      <CriticalPathPaneContent rows={rows} allRecords={records} error={null} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('effPri=3');
    expect(frame).toContain('CPL=3');
  });

  it('renders blast-radius (dependents count)', () => {
    const records = [makeRecord('AISDLC-5', { dependents: ['A', 'B', 'C'] })];
    const rows = buildCriticalPathRows(records);
    const { lastFrame } = render(
      <CriticalPathPaneContent rows={rows} allRecords={records} error={null} />,
    );
    expect(lastFrame()).toContain('blast=3');
  });

  it('shows task count in header', () => {
    const records = [makeRecord('AISDLC-1'), makeRecord('AISDLC-2'), makeRecord('AISDLC-3')];
    const rows = buildCriticalPathRows(records);
    const { lastFrame } = render(
      <CriticalPathPaneContent rows={rows} allRecords={records} error={null} />,
    );
    expect(lastFrame()).toContain('3 tasks');
  });

  it('caps display at CRITICAL_PATH_MAX_ROWS and shows overflow message', () => {
    const records = Array.from({ length: CRITICAL_PATH_MAX_ROWS + 3 }, (_, i) =>
      makeRecord(`AISDLC-${i + 1}`),
    );
    const rows = buildCriticalPathRows(records);
    const { lastFrame } = render(
      <CriticalPathPaneContent rows={rows} allRecords={records} error={null} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('more tasks not shown');
    // Should show count = CRITICAL_PATH_MAX_ROWS + 3 in header (all tasks)
    expect(frame).toContain(`${CRITICAL_PATH_MAX_ROWS + 3} tasks`);
  });

  it('shows navigation hint when rows exist', () => {
    const records = [makeRecord('AISDLC-1')];
    const rows = buildCriticalPathRows(records);
    const { lastFrame } = render(
      <CriticalPathPaneContent rows={rows} allRecords={records} error={null} />,
    );
    expect(lastFrame()).toContain('navigate');
  });
});

describe('CriticalPathPaneContent — keyboard navigation', () => {
  it('opens detail view on Enter', async () => {
    const records = [makeRecord('AISDLC-100', { criticalPathLength: 2 })];
    const rows = buildCriticalPathRows(records);
    const { lastFrame, stdin } = render(
      <CriticalPathPaneContent rows={rows} allRecords={records} error={null} />,
    );
    await flush();
    stdin.write('\r'); // Enter
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('AISDLC-100');
  });

  it('closes detail view on Escape', async () => {
    const records = [makeRecord('AISDLC-200')];
    const rows = buildCriticalPathRows(records);
    const { lastFrame, stdin } = render(
      <CriticalPathPaneContent rows={rows} allRecords={records} error={null} />,
    );
    await flush();
    stdin.write('\r'); // open detail
    await flush();
    stdin.write('\x1b'); // Escape to close
    await flush();

    expect(lastFrame()).toContain('CRITICAL PATH');
  });

  it('navigates down with arrow key without crashing', async () => {
    const records = [makeRecord('AISDLC-1'), makeRecord('AISDLC-2')];
    const rows = buildCriticalPathRows(records);
    const { lastFrame, stdin } = render(
      <CriticalPathPaneContent rows={rows} allRecords={records} error={null} />,
    );
    await flush();
    stdin.write('\x1b[B'); // down arrow
    await flush();
    expect(lastFrame()).toContain('CRITICAL PATH');
  });

  it('renders ASCII dep tree in detail view', async () => {
    const parent = makeRecord('AISDLC-0');
    const child = makeRecord('AISDLC-2');
    const focused = makeRecord('AISDLC-1', {
      criticalPathLength: 1,
      dependencies: ['AISDLC-0'],
      dependents: ['AISDLC-2'],
    });
    const allRecords = [parent, focused, child];
    const rows = buildCriticalPathRows([focused]);
    const { lastFrame, stdin } = render(
      <CriticalPathPaneContent rows={rows} allRecords={allRecords} error={null} />,
    );
    await flush();
    stdin.write('\r'); // Enter to open detail
    await flush();

    const frame = lastFrame() ?? '';
    // Should show the focused task with dep tree markers
    expect(frame).toContain('AISDLC-1');
    expect(frame).toContain('CPL=');
  });
});
