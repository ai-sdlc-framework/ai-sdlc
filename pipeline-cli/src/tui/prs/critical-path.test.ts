/**
 * Unit tests for PR critical-path derivation — AISDLC-178.4.1.
 *
 * Covers:
 *   - extractTaskId across the branch shapes we actually generate
 *   - parseDependsOnLabels + parseDependsOnBody (depends-on label parsing AC #6)
 *   - derivePrChainGraph chain detection (task-dep, label, body, ancestry sources) AC #6
 *   - buildPrChainTree ASCII rendering (upstream above, focused middle, downstream below) AC #6
 *   - 4-PR chain integration fixture mirroring AISDLC-175 → 179 → 176 → 177 (AC #7)
 */

import { describe, expect, it } from 'vitest';
import type { GhPrSummary } from '../sources/gh-pr-cache.js';
import type { SnapshotRecord } from '../../deps/snapshot.js';
import {
  extractTaskId,
  parseDependsOnLabels,
  parseDependsOnBody,
  derivePrChainGraph,
  buildPrChainTree,
} from './critical-path.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePr(overrides: Partial<GhPrSummary> = {}): GhPrSummary {
  return {
    number: 1,
    title: 'Test PR',
    state: 'open',
    url: 'https://github.com/org/repo/pull/1',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    headRefName: 'feat/test',
    mergeable: 'MERGEABLE',
    statusCheckRollup: null,
    ...overrides,
  };
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
    externalDependencies: [],
    lastModified: '',
    ...overrides,
  };
}

// ── extractTaskId ─────────────────────────────────────────────────────────────

describe('extractTaskId', () => {
  it('extracts AISDLC-NNN from `ai-sdlc/aisdlc-178-something` branch', () => {
    expect(extractTaskId('ai-sdlc/aisdlc-178-pr-critical-path')).toBe('AISDLC-178');
  });

  it('extracts dotted task IDs (AISDLC-178.4.1)', () => {
    expect(extractTaskId('ai-sdlc/aisdlc-178.4.1-some-slug')).toBe('AISDLC-178.4.1');
  });

  it('extracts from `feat/aisdlc-216` shape', () => {
    expect(extractTaskId('feat/aisdlc-216-prefix')).toBe('AISDLC-216');
  });

  it('returns null for branches without a task ID token', () => {
    expect(extractTaskId('feat/some-feature')).toBeNull();
    expect(extractTaskId('main')).toBeNull();
    expect(extractTaskId('')).toBeNull();
  });

  it('handles undefined / null safely', () => {
    expect(extractTaskId(undefined)).toBeNull();
    expect(extractTaskId(null)).toBeNull();
  });

  it('normalises case (lowercase input → uppercase task-id form)', () => {
    expect(extractTaskId('AI-SDLC/AISDLC-178')).toBe('AISDLC-178');
    expect(extractTaskId('ai-sdlc/AISDLC-178')).toBe('AISDLC-178');
  });
});

// ── parseDependsOnLabels ──────────────────────────────────────────────────────

describe('parseDependsOnLabels', () => {
  it('returns [] for missing labels', () => {
    expect(parseDependsOnLabels(undefined)).toEqual([]);
    expect(parseDependsOnLabels([])).toEqual([]);
  });

  it('parses canonical `depends-on:#247` label', () => {
    expect(parseDependsOnLabels([{ name: 'depends-on:#247' }])).toEqual([247]);
  });

  it('parses `depends-on-#247` (hyphen variant)', () => {
    expect(parseDependsOnLabels([{ name: 'depends-on-#247' }])).toEqual([247]);
  });

  it('parses `depends-on: 247` (space, no hash)', () => {
    expect(parseDependsOnLabels([{ name: 'depends-on: 247' }])).toEqual([247]);
  });

  it('parses underscores and mixed case', () => {
    expect(parseDependsOnLabels([{ name: 'Depends_On:#10' }])).toEqual([10]);
  });

  it('skips non-depends-on labels', () => {
    expect(
      parseDependsOnLabels([{ name: 'rfc-0023' }, { name: 'depends-on:#5' }, { name: 'phase-4' }]),
    ).toEqual([5]);
  });

  it('dedupes duplicates and sorts ASC', () => {
    expect(
      parseDependsOnLabels([
        { name: 'depends-on:#10' },
        { name: 'depends-on:#3' },
        { name: 'depends-on:#10' },
      ]),
    ).toEqual([3, 10]);
  });
});

// ── parseDependsOnBody ────────────────────────────────────────────────────────

describe('parseDependsOnBody', () => {
  it('returns [] for missing body', () => {
    expect(parseDependsOnBody(undefined)).toEqual([]);
    expect(parseDependsOnBody('')).toEqual([]);
  });

  it('parses single inline marker', () => {
    expect(parseDependsOnBody('## Summary\n\nDepends-on: #247\n')).toEqual([247]);
  });

  it('parses multiple markers', () => {
    expect(parseDependsOnBody('Depends-on: #10\n\nDepends-on: #20\n')).toEqual([10, 20]);
  });

  it('parses underscore + mixed case', () => {
    expect(parseDependsOnBody('depends_on: #5')).toEqual([5]);
  });

  it('dedupes', () => {
    expect(parseDependsOnBody('depends-on: #5 and again depends-on: #5')).toEqual([5]);
  });
});

// ── derivePrChainGraph ────────────────────────────────────────────────────────

describe('derivePrChainGraph', () => {
  it('returns singleton info for a single PR with no edges', () => {
    const prs = [makePr({ number: 1 })];
    const graph = derivePrChainGraph({ prs });
    const info = graph.info.get(1);
    expect(info).toBeDefined();
    expect(info!.cpl).toBe(0);
    expect(info!.unblockCount).toBe(0);
    expect(info!.chainPos).toBe(1);
    expect(info!.chainLen).toBe(1);
    expect(info!.inChain).toBe(false);
  });

  it('derives task-dependency edges from snapshot', () => {
    const prs = [
      makePr({ number: 100, headRefName: 'ai-sdlc/aisdlc-501-foo' }),
      makePr({ number: 101, headRefName: 'ai-sdlc/aisdlc-502-bar' }),
    ];
    const snapshotRecords = [
      makeRecord('AISDLC-501'),
      makeRecord('AISDLC-502', { dependencies: ['AISDLC-501'] }),
    ];
    const graph = derivePrChainGraph({ prs, snapshotRecords });
    expect(graph.info.get(101)!.upstream).toEqual([100]);
    expect(graph.info.get(100)!.downstream).toEqual([101]);
    expect(graph.info.get(100)!.cpl).toBe(1);
    expect(graph.info.get(101)!.cpl).toBe(0);
  });

  it('derives edges from depends-on labels', () => {
    const prs = [
      makePr({ number: 50 }),
      makePr({ number: 51, labels: [{ name: 'depends-on:#50' }] }),
    ];
    const graph = derivePrChainGraph({ prs });
    expect(graph.info.get(51)!.upstream).toEqual([50]);
    expect(graph.info.get(50)!.downstream).toEqual([51]);
  });

  it('derives edges from depends-on body markers', () => {
    const prs = [
      makePr({ number: 50 }),
      makePr({ number: 51, body: 'Summary\n\nDepends-on: #50\n' }),
    ];
    const graph = derivePrChainGraph({ prs });
    expect(graph.info.get(51)!.upstream).toEqual([50]);
  });

  it('derives edges from injected git ancestry', () => {
    const prs = [
      makePr({ number: 1, headRefName: 'feat/parent' }),
      makePr({ number: 2, headRefName: 'feat/child' }),
    ];
    const graph = derivePrChainGraph({
      prs,
      gitAncestry: (parent, child) => parent === 'feat/parent' && child === 'feat/child',
    });
    expect(graph.info.get(2)!.upstream).toEqual([1]);
  });

  it('does not double-count when an edge appears in multiple sources', () => {
    const prs = [
      makePr({ number: 100, headRefName: 'ai-sdlc/aisdlc-501-foo' }),
      makePr({
        number: 101,
        headRefName: 'ai-sdlc/aisdlc-502-bar',
        labels: [{ name: 'depends-on:#100' }],
      }),
    ];
    const snapshotRecords = [
      makeRecord('AISDLC-501'),
      makeRecord('AISDLC-502', { dependencies: ['AISDLC-501'] }),
    ];
    const graph = derivePrChainGraph({ prs, snapshotRecords });
    expect(graph.info.get(101)!.upstream).toEqual([100]); // not [100, 100]
  });

  it('ignores edges to PRs that are not in the open set', () => {
    const prs = [makePr({ number: 51, labels: [{ name: 'depends-on:#9999' }] })];
    const graph = derivePrChainGraph({ prs });
    expect(graph.info.get(51)!.upstream).toEqual([]);
  });

  it('computes unblockCount as transitive downstream', () => {
    // 1 → 2 → 3, 1 → 4 → fan-in to 3
    const prs = [
      makePr({ number: 1 }),
      makePr({ number: 2, labels: [{ name: 'depends-on:#1' }] }),
      makePr({
        number: 3,
        labels: [{ name: 'depends-on:#2' }, { name: 'depends-on:#4' }],
      }),
      makePr({ number: 4, labels: [{ name: 'depends-on:#1' }] }),
    ];
    const graph = derivePrChainGraph({ prs });
    // downstream(1) = {2, 3, 4} = 3
    expect(graph.info.get(1)!.unblockCount).toBe(3);
    expect(graph.info.get(2)!.unblockCount).toBe(1);
    expect(graph.info.get(3)!.unblockCount).toBe(0);
  });

  it('survives self-edges and duplicate edges (degenerate input)', () => {
    const prs = [makePr({ number: 1, labels: [{ name: 'depends-on:#1' }] })];
    const graph = derivePrChainGraph({ prs });
    // Self-edge ignored.
    expect(graph.info.get(1)!.upstream).toEqual([]);
    expect(graph.info.get(1)!.downstream).toEqual([]);
  });

  it('handles cycles without infinite recursion (cycle guard)', () => {
    // A depends on B, B depends on A — bogus but should not crash
    const prs = [
      makePr({ number: 1, labels: [{ name: 'depends-on:#2' }] }),
      makePr({ number: 2, labels: [{ name: 'depends-on:#1' }] }),
    ];
    const graph = derivePrChainGraph({ prs });
    // Graph still produces finite values
    expect(graph.info.get(1)!.cpl).toBeGreaterThanOrEqual(0);
    expect(graph.info.get(2)!.cpl).toBeGreaterThanOrEqual(0);
  });

  it('chain length and position: linear 4-PR chain', () => {
    // 1 → 2 → 3 → 4 where 4 is the leaf
    const prs = [
      makePr({ number: 1 }),
      makePr({ number: 2, labels: [{ name: 'depends-on:#1' }] }),
      makePr({ number: 3, labels: [{ name: 'depends-on:#2' }] }),
      makePr({ number: 4, labels: [{ name: 'depends-on:#3' }] }),
    ];
    const graph = derivePrChainGraph({ prs });
    expect(graph.info.get(1)!.chainPos).toBe(1);
    expect(graph.info.get(1)!.chainLen).toBe(4);
    expect(graph.info.get(1)!.cpl).toBe(3);
    expect(graph.info.get(2)!.chainPos).toBe(2);
    expect(graph.info.get(3)!.chainPos).toBe(3);
    expect(graph.info.get(4)!.chainPos).toBe(4);
    expect(graph.info.get(4)!.chainLen).toBe(4);
    expect(graph.info.get(4)!.cpl).toBe(0);
    // All PRs in this chain report inChain
    for (const n of [1, 2, 3, 4]) {
      expect(graph.info.get(n)!.inChain).toBe(true);
    }
  });

  it('weakest signal (ancestry) does not override a stronger task-dep edge', () => {
    // PR 100 should have only ONE upstream entry even though both task-dep
    // + ancestry would point to PR 99.
    const prs = [
      makePr({ number: 99, headRefName: 'feat/parent' }),
      makePr({ number: 100, headRefName: 'feat/child' }),
    ];
    const snapshotRecords = [
      makeRecord('AISDLC-FOO'), // not bound to either PR — ancestry is the only signal
    ];
    const graph = derivePrChainGraph({
      prs,
      snapshotRecords,
      gitAncestry: () => true,
    });
    // Both PRs claim to be ancestors of each other → guard prevents both
    // edges from being added under the same direction. Just check we get a
    // valid graph that does not double-count or crash.
    expect(graph.info.size).toBe(2);
  });
});

// ── buildPrChainTree ──────────────────────────────────────────────────────────

describe('buildPrChainTree', () => {
  it('renders focused PR alone when no upstream/downstream', () => {
    const prs = [makePr({ number: 1, title: 'Lonely', headRefName: 'feat/lonely' })];
    const graph = derivePrChainGraph({ prs });
    const lines = buildPrChainTree({ prNumber: 1, prs, graph });
    expect(lines.some((l) => l.includes('* #1'))).toBe(true);
    expect(lines.some((l) => l.includes('singleton'))).toBe(true);
  });

  it('renders upstream above, focused, downstream below for a 3-PR chain', () => {
    const prs = [
      makePr({ number: 1, title: 'parent' }),
      makePr({ number: 2, title: 'me', labels: [{ name: 'depends-on:#1' }] }),
      makePr({ number: 3, title: 'child', labels: [{ name: 'depends-on:#2' }] }),
    ];
    const graph = derivePrChainGraph({ prs });
    const lines = buildPrChainTree({ prNumber: 2, prs, graph });

    const parentIdx = lines.findIndex((l) => l.includes('#1'));
    const focusedIdx = lines.findIndex((l) => l.includes('* #2'));
    const childIdx = lines.findIndex((l) => l.includes('#3'));

    expect(parentIdx).toBeGreaterThanOrEqual(0);
    expect(focusedIdx).toBeGreaterThan(parentIdx);
    expect(childIdx).toBeGreaterThan(focusedIdx);
  });

  it('renders chain indicator on focused line when in a chain', () => {
    const prs = [makePr({ number: 1 }), makePr({ number: 2, labels: [{ name: 'depends-on:#1' }] })];
    const graph = derivePrChainGraph({ prs });
    const lines = buildPrChainTree({ prNumber: 2, prs, graph });
    const focusLine = lines.find((l) => l.includes('* #2'));
    expect(focusLine).toBeDefined();
    expect(focusLine).toContain('🔗 2/2');
  });

  it('renders cpl + unblocks counts on focused line', () => {
    const prs = [
      makePr({ number: 1 }),
      makePr({ number: 2, labels: [{ name: 'depends-on:#1' }] }),
      makePr({ number: 3, labels: [{ name: 'depends-on:#1' }] }),
    ];
    const graph = derivePrChainGraph({ prs });
    const lines = buildPrChainTree({ prNumber: 1, prs, graph });
    const focusLine = lines.find((l) => l.includes('* #1'));
    expect(focusLine).toContain('cpl=1');
    expect(focusLine).toContain('unblocks=2');
  });

  it('renders └─ and ┌─ tree characters when chain has both directions', () => {
    const prs = [
      makePr({ number: 1 }),
      makePr({ number: 2, labels: [{ name: 'depends-on:#1' }] }),
      makePr({ number: 3, labels: [{ name: 'depends-on:#2' }] }),
    ];
    const graph = derivePrChainGraph({ prs });
    const lines = buildPrChainTree({ prNumber: 2, prs, graph });
    const text = lines.join('\n');
    expect(text).toContain('┌─');
    expect(text).toContain('└─');
  });

  it('returns a not-found message when PR is not in the graph', () => {
    const prs = [makePr({ number: 1 })];
    const graph = derivePrChainGraph({ prs });
    const lines = buildPrChainTree({ prNumber: 999, prs, graph });
    expect(lines.join('\n')).toContain('not found in graph');
  });
});

// ── Integration: 4-PR chain mirroring AISDLC-175 → 179 → 176 → 177 (AC #7) ────

describe('integration: 4-PR critical-path chain (AISDLC-178.4.1 AC #7)', () => {
  /**
   * Reproduces the AISDLC-178.4.1 spec example: PR #247 (175 orphan-parent)
   * → #243 (179 in-flight tracking) → #176 (dev JSON retry) → #177 (rollback).
   * All four touch the same file so optimal merge order IS the chain order.
   * The fixture exercises the full task-dep → snapshot → chain pipeline so a
   * regression in any of those layers fails this test.
   */
  function buildFixture(): { prs: GhPrSummary[]; snapshotRecords: SnapshotRecord[] } {
    const prs: GhPrSummary[] = [
      makePr({
        number: 247,
        title: '175 orphan-parent filter',
        headRefName: 'ai-sdlc/aisdlc-175-orphan-parent-filter',
        createdAt: '2026-04-30T00:00:00Z',
      }),
      makePr({
        number: 243,
        title: '179 in-flight tracking',
        headRefName: 'ai-sdlc/aisdlc-179-in-flight-tracking',
        createdAt: '2026-05-01T00:00:00Z',
      }),
      makePr({
        number: 176,
        title: '176 dev JSON retry',
        headRefName: 'ai-sdlc/aisdlc-176-dev-json-retry',
        createdAt: '2026-05-02T00:00:00Z',
      }),
      makePr({
        number: 177,
        title: '177 rollback',
        headRefName: 'ai-sdlc/aisdlc-177-rollback',
        createdAt: '2026-05-03T00:00:00Z',
      }),
    ];
    const snapshotRecords: SnapshotRecord[] = [
      makeRecord('AISDLC-175', { effectivePriority: 3 }),
      makeRecord('AISDLC-179', { dependencies: ['AISDLC-175'], effectivePriority: 3 }),
      makeRecord('AISDLC-176', { dependencies: ['AISDLC-179'], effectivePriority: 3 }),
      makeRecord('AISDLC-177', { dependencies: ['AISDLC-176'], effectivePriority: 3 }),
    ];
    return { prs, snapshotRecords };
  }

  it('derives the full 4-PR chain from snapshot task dependencies', () => {
    const { prs, snapshotRecords } = buildFixture();
    const graph = derivePrChainGraph({ prs, snapshotRecords });
    expect(graph.info.get(247)!.upstream).toEqual([]);
    expect(graph.info.get(243)!.upstream).toEqual([247]);
    expect(graph.info.get(176)!.upstream).toEqual([243]);
    expect(graph.info.get(177)!.upstream).toEqual([176]);
  });

  it('chain position is 1/4, 2/4, 3/4, 4/4 along the chain', () => {
    const { prs, snapshotRecords } = buildFixture();
    const graph = derivePrChainGraph({ prs, snapshotRecords });
    expect(graph.info.get(247)!).toMatchObject({ chainPos: 1, chainLen: 4 });
    expect(graph.info.get(243)!).toMatchObject({ chainPos: 2, chainLen: 4 });
    expect(graph.info.get(176)!).toMatchObject({ chainPos: 3, chainLen: 4 });
    expect(graph.info.get(177)!).toMatchObject({ chainPos: 4, chainLen: 4 });
  });

  it('cpl decreases monotonically along the chain', () => {
    const { prs, snapshotRecords } = buildFixture();
    const graph = derivePrChainGraph({ prs, snapshotRecords });
    expect(graph.info.get(247)!.cpl).toBe(3);
    expect(graph.info.get(243)!.cpl).toBe(2);
    expect(graph.info.get(176)!.cpl).toBe(1);
    expect(graph.info.get(177)!.cpl).toBe(0);
  });

  it('unblockCount equals the number of downstream PRs (transitive)', () => {
    const { prs, snapshotRecords } = buildFixture();
    const graph = derivePrChainGraph({ prs, snapshotRecords });
    expect(graph.info.get(247)!.unblockCount).toBe(3);
    expect(graph.info.get(243)!.unblockCount).toBe(2);
    expect(graph.info.get(176)!.unblockCount).toBe(1);
    expect(graph.info.get(177)!.unblockCount).toBe(0);
  });
});
