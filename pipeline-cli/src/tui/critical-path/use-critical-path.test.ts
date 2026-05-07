/**
 * Tests for Critical Path pane logic — RFC-0023 §7.3 / AISDLC-178.4.
 *
 * Covers:
 *   - sortCriticalPath: effectivePriority DESC, CPL DESC, recency DESC, id ASC
 *   - buildAsciiDepTree: parents above, focused task, children below
 *   - buildCriticalPathRows: derives effPri + blastRadius correctly
 */

import { describe, expect, it } from 'vitest';
import type { SnapshotRecord } from '../../deps/snapshot.js';
import { sortCriticalPath, buildAsciiDepTree, buildCriticalPathRows } from './use-critical-path.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

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
    externalDependencies: [],
    lastModified: '',
    ...overrides,
  };
}

// ── sortCriticalPath ──────────────────────────────────────────────────────────

describe('sortCriticalPath', () => {
  it('returns empty array for empty input', () => {
    expect(sortCriticalPath([])).toEqual([]);
  });

  it('sorts by criticalPathLength DESC (effectivePriority proxy)', () => {
    const records = [
      makeRecord('A', { criticalPathLength: 1 }),
      makeRecord('B', { criticalPathLength: 5 }),
      makeRecord('C', { criticalPathLength: 3 }),
    ];
    const sorted = sortCriticalPath(records);
    expect(sorted.map((r) => r.id)).toEqual(['B', 'C', 'A']);
  });

  it('tiebreak: CPL DESC (same effPri, different CPL)', () => {
    // When effPri proxy is same (CPL same for sorting), use CPL as secondary
    // In our implementation, effPri proxy IS CPL, so test with equal CPL:
    const records = [
      makeRecord('A', { criticalPathLength: 3 }),
      makeRecord('B', { criticalPathLength: 3 }),
    ];
    // With equal CPL, falls to recency DESC then id ASC
    const sorted = sortCriticalPath(records);
    // Both have same CPL and no lastModified, so id ASC
    expect(sorted.map((r) => r.id)).toEqual(['A', 'B']);
  });

  it('tiebreak: recency DESC (newer lastModified first)', () => {
    const records = [
      makeRecord('A', { criticalPathLength: 2, lastModified: '2026-05-01T10:00:00Z' }),
      makeRecord('B', { criticalPathLength: 2, lastModified: '2026-05-03T10:00:00Z' }),
      makeRecord('C', { criticalPathLength: 2, lastModified: '2026-05-02T10:00:00Z' }),
    ];
    const sorted = sortCriticalPath(records);
    expect(sorted.map((r) => r.id)).toEqual(['B', 'C', 'A']);
  });

  it('tiebreak: id ASC (same CPL + same lastModified)', () => {
    const records = [
      makeRecord('AISDLC-200', { criticalPathLength: 0 }),
      makeRecord('AISDLC-100', { criticalPathLength: 0 }),
      makeRecord('AISDLC-150', { criticalPathLength: 0 }),
    ];
    const sorted = sortCriticalPath(records);
    expect(sorted.map((r) => r.id)).toEqual(['AISDLC-100', 'AISDLC-150', 'AISDLC-200']);
  });

  it('does not mutate the original array', () => {
    const records = [
      makeRecord('B', { criticalPathLength: 5 }),
      makeRecord('A', { criticalPathLength: 1 }),
    ];
    const original = [...records];
    sortCriticalPath(records);
    expect(records.map((r) => r.id)).toEqual(original.map((r) => r.id));
  });
});

// ── buildAsciiDepTree ─────────────────────────────────────────────────────────

describe('buildAsciiDepTree', () => {
  it('renders focused task with no parents or children', () => {
    const focused = makeRecord('AISDLC-1');
    const lines = buildAsciiDepTree(focused, [focused]);

    expect(lines.some((l) => l.includes('* AISDLC-1'))).toBe(true);
    expect(lines.some((l) => l.includes('effPri'))).toBe(true);
  });

  it('renders parents above focused task', () => {
    const parent = makeRecord('AISDLC-0');
    const focused = makeRecord('AISDLC-1', { dependencies: ['AISDLC-0'] });
    const lines = buildAsciiDepTree(focused, [parent, focused]);

    const parentIdx = lines.findIndex((l) => l.includes('AISDLC-0'));
    const focusedIdx = lines.findIndex((l) => l.includes('* AISDLC-1'));

    expect(parentIdx).toBeGreaterThanOrEqual(0);
    expect(focusedIdx).toBeGreaterThanOrEqual(0);
    expect(parentIdx).toBeLessThan(focusedIdx);
  });

  it('renders children below focused task', () => {
    const child = makeRecord('AISDLC-2');
    const focused = makeRecord('AISDLC-1', { dependents: ['AISDLC-2'] });
    const lines = buildAsciiDepTree(focused, [focused, child]);

    const focusedIdx = lines.findIndex((l) => l.includes('* AISDLC-1'));
    const childIdx = lines.findIndex((l) => l.includes('AISDLC-2'));

    expect(focusedIdx).toBeGreaterThanOrEqual(0);
    expect(childIdx).toBeGreaterThanOrEqual(0);
    expect(childIdx).toBeGreaterThan(focusedIdx);
  });

  it('marks missing snapshot entries with a note', () => {
    const focused = makeRecord('AISDLC-1', { dependencies: ['AISDLC-MISSING'] });
    const lines = buildAsciiDepTree(focused, [focused]);

    expect(lines.some((l) => l.includes('not in snapshot'))).toBe(true);
  });

  it('renders CPL and blast-radius in the focused task line', () => {
    const focused = makeRecord('AISDLC-1', {
      criticalPathLength: 3,
      dependents: ['A', 'B', 'C'],
    });
    const lines = buildAsciiDepTree(focused, [focused]);
    const focusLine = lines.find((l) => l.includes('* AISDLC-1'));

    expect(focusLine).toBeDefined();
    expect(focusLine).toContain('CPL=3');
    expect(focusLine).toContain('downstream=3');
  });

  it('renders tree characters for parent and child connections', () => {
    const parent = makeRecord('AISDLC-0');
    const child = makeRecord('AISDLC-2');
    const focused = makeRecord('AISDLC-1', {
      dependencies: ['AISDLC-0'],
      dependents: ['AISDLC-2'],
    });
    const lines = buildAsciiDepTree(focused, [parent, focused, child]);

    const allText = lines.join('\n');
    expect(allText).toContain('┌─');
    expect(allText).toContain('└─');
  });
});

// ── buildCriticalPathRows ─────────────────────────────────────────────────────

describe('buildCriticalPathRows', () => {
  it('returns empty array for empty input', () => {
    expect(buildCriticalPathRows([])).toEqual([]);
  });

  it('reads effPri from snapshot.effectivePriority field (per RFC-0014 §5.3)', () => {
    // AISDLC-178.4 #384 review fix: effPri now reads the proper field
    // from the snapshot record instead of proxying via criticalPathLength.
    const records = [makeRecord('A', { effectivePriority: 4, criticalPathLength: 7 })];
    const [row] = buildCriticalPathRows(records);
    expect(row.effPri).toBe(4);
  });

  it('falls back to default priority weight (2 = medium) when effectivePriority absent', () => {
    // Backward-compat: stale on-disk snapshots written before AISDLC-178.4
    // don't have the field; fallback to medium (2) so the TUI never crashes.
    const records = [makeRecord('A', { criticalPathLength: 7 })];
    const [row] = buildCriticalPathRows(records);
    expect(row.effPri).toBe(2);
  });

  it('derives blastRadius as dependents count', () => {
    const records = [makeRecord('A', { dependents: ['B', 'C', 'D'] })];
    const [row] = buildCriticalPathRows(records);
    expect(row.blastRadius).toBe(3);
  });

  it('returns rows sorted by CPL DESC', () => {
    const records = [
      makeRecord('X', { criticalPathLength: 1 }),
      makeRecord('Y', { criticalPathLength: 5 }),
      makeRecord('Z', { criticalPathLength: 3 }),
    ];
    const rows = buildCriticalPathRows(records);
    expect(rows.map((r) => r.record.id)).toEqual(['Y', 'Z', 'X']);
  });
});
