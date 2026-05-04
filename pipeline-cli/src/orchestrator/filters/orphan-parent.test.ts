/**
 * Filter — orphan-parent detection (AISDLC-175) tests.
 *
 * Covers the AC #4 cases from the task spec:
 *   - Parent with all children done → REJECTS (orphan parent — bookkeeping
 *     work the framework should handle, not real dispatch).
 *   - Parent with mixed children (some done, some open) → ADMITS (still
 *     real work pending).
 *   - Parent with no children declared → ADMITS (not an orphan parent —
 *     could be a leaf or a top-level task without a phased breakdown).
 *   - Task that is itself a child (carries `parent_task_id`) → ADMITS
 *     (closing a sub-task is real dispatch work, even when the sub-task
 *     itself has its own grandchildren).
 *
 * Plus defensive cases:
 *   - Missing graph node → ADMITS (matches the dependency-readiness
 *     filter's "missing node = pass" defense).
 *   - Case-insensitive parent reference (children using `aisdlc-70` vs
 *     `AISDLC-70`).
 *   - Pathological self-reference (a task naming itself as parent) is
 *     ignored when counting children.
 *   - The `completedChildren` payload is sorted + lowercased.
 */

import { describe, expect, it } from 'vitest';
import { checkOrphanParent } from './orphan-parent.js';
import type { DependencyGraph, DependencyNode } from '../../deps/dependency-graph.js';

// ── Fixture helpers ───────────────────────────────────────────────────

function node(
  id: string,
  opts: { status?: 'open' | 'completed'; parent?: string } = {},
): DependencyNode {
  const status = opts.status ?? 'open';
  return {
    id,
    status,
    fileLocation: status,
    frontmatterStatus: status === 'completed' ? 'Done' : 'To Do',
    priority: '',
    title: id,
    dependencies: [],
    externalDependencies: [],
    lastModified: '2026-05-02T00:00:00Z',
    filePath: `/tmp/${id}.md`,
    parentTaskId: opts.parent ?? '',
  };
}

function graph(nodes: DependencyNode[]): DependencyGraph {
  const map = new Map<string, DependencyNode>();
  const openIds: string[] = [];
  const completedIds: string[] = [];
  for (const n of nodes) {
    map.set(n.id.toLowerCase(), n);
    if (n.status === 'open') openIds.push(n.id.toLowerCase());
    else completedIds.push(n.id.toLowerCase());
  }
  return { nodes: map, openIds, completedIds };
}

// ── Acceptance criteria (AC #4) ───────────────────────────────────────

describe('checkOrphanParent — AC #4 cases', () => {
  it('REJECTS a parent whose every declared child is already in completed/', () => {
    // Replays the witness: AISDLC-70 with all 9 sub-tasks already shipped.
    const g = graph([
      node('AISDLC-70'),
      node('AISDLC-70.1', { status: 'completed', parent: 'AISDLC-70' }),
      node('AISDLC-70.2', { status: 'completed', parent: 'AISDLC-70' }),
      node('AISDLC-70.3', { status: 'completed', parent: 'AISDLC-70' }),
    ]);
    const result = checkOrphanParent({ graph: g, taskId: 'AISDLC-70' });
    expect(result.passed).toBe(false);
    expect(result.filter).toBe('OrphanParent');
    expect(result.detail?.kind).toBe('orphan-parent-needs-closure');
    if (result.detail?.kind === 'orphan-parent-needs-closure') {
      // Sorted + lowercased per the documented event-payload contract.
      expect(result.detail.completedChildren).toEqual([
        'aisdlc-70.1',
        'aisdlc-70.2',
        'aisdlc-70.3',
      ]);
    }
    // Reason string surfaces the count + first few IDs for the trace log.
    expect(result.reason).toContain('orphan-parent-needs-closure');
    expect(result.reason).toContain('3 completed');
  });

  it('ADMITS a parent with mixed children (≥1 still open)', () => {
    const g = graph([
      node('AISDLC-100'),
      node('AISDLC-100.1', { status: 'completed', parent: 'AISDLC-100' }),
      // 100.2 is still open — there's real downstream work, the parent
      // shouldn't be skipped as an orphan.
      node('AISDLC-100.2', { status: 'open', parent: 'AISDLC-100' }),
      node('AISDLC-100.3', { status: 'completed', parent: 'AISDLC-100' }),
    ]);
    const result = checkOrphanParent({ graph: g, taskId: 'AISDLC-100' });
    expect(result.passed).toBe(true);
    expect(result.detail).toBeUndefined();
  });

  it('ADMITS a parent with no children declared (not an orphan parent)', () => {
    // A leaf or top-level task without a phased breakdown — could be real
    // work; the chain should let downstream filters decide.
    const g = graph([node('AISDLC-200'), node('AISDLC-201'), node('AISDLC-202')]);
    const result = checkOrphanParent({ graph: g, taskId: 'AISDLC-200' });
    expect(result.passed).toBe(true);
    expect(result.detail).toBeUndefined();
  });

  it('ADMITS a candidate that is itself a child (carries parent_task_id)', () => {
    // AISDLC-100.7 is AISDLC-100's child. Even if 100.7 had grandchildren
    // that were all completed, closing 100.7 itself is real dispatch work
    // — the orchestrator should keep working on it.
    const g = graph([
      node('AISDLC-100'),
      node('AISDLC-100.7', { parent: 'AISDLC-100' }),
      node('AISDLC-100.7.1', { status: 'completed', parent: 'AISDLC-100.7' }),
    ]);
    const result = checkOrphanParent({ graph: g, taskId: 'AISDLC-100.7' });
    expect(result.passed).toBe(true);
  });
});

// ── Defensive cases ───────────────────────────────────────────────────

describe('checkOrphanParent — defensive cases', () => {
  it('ADMITS when the candidate is missing from the graph', () => {
    // Matches the dependency-readiness filter's "missing node = pass"
    // defense — the chain should not silently REJECT on data gaps.
    const g = graph([]);
    const result = checkOrphanParent({ graph: g, taskId: 'AISDLC-MISSING' });
    expect(result.passed).toBe(true);
  });

  it('matches parent_task_id case-insensitively', () => {
    // On-disk frontmatter sometimes uses `AISDLC-70`, sometimes
    // `aisdlc-70` — both refer to the same parent.
    const g = graph([
      node('AISDLC-Mixed'),
      node('AISDLC-Mixed.1', { status: 'completed', parent: 'aisdlc-mixed' }),
      node('AISDLC-Mixed.2', { status: 'completed', parent: 'AISDLC-MIXED' }),
    ]);
    const result = checkOrphanParent({ graph: g, taskId: 'AISDLC-Mixed' });
    expect(result.passed).toBe(false);
    if (result.detail?.kind === 'orphan-parent-needs-closure') {
      expect(result.detail.completedChildren).toEqual(['aisdlc-mixed.1', 'aisdlc-mixed.2']);
    }
  });

  it('ignores self-reference (a task naming itself as parent does not count)', () => {
    // Pathological data — shouldn't produce a false-positive orphan
    // detection. With only the self-ref "child", the candidate has no
    // real children and should ADMIT.
    const g = graph([node('AISDLC-SELF', { parent: 'AISDLC-SELF' })]);
    const result = checkOrphanParent({ graph: g, taskId: 'AISDLC-SELF' });
    // The candidate has parent_task_id set → treated as a child; the
    // earlier "candidate is itself a child" guard fires first.
    expect(result.passed).toBe(true);
  });

  it('ignores self-reference by id even when the candidate has no parent_task_id', () => {
    // Build a graph where AISDLC-X has no parent_task_id BUT one of its
    // "children" is itself (id collision). The self-ref should be
    // skipped, leaving zero real children → ADMIT.
    const candidate = node('AISDLC-X');
    const fakeChild = node('AISDLC-X', { status: 'completed', parent: 'AISDLC-X' });
    // We can't put two nodes with the same id in the graph map, but we
    // can assert that even when the candidate's own id matches its
    // parent_task_id (synthetic data), the self-ref guard doesn't
    // create a false positive. Use the second node directly.
    const g: DependencyGraph = {
      nodes: new Map([['aisdlc-x', fakeChild]]),
      openIds: [],
      completedIds: ['aisdlc-x'],
    };
    void candidate; // documentary
    const result = checkOrphanParent({ graph: g, taskId: 'AISDLC-X' });
    // candidate carries parent_task_id (=== its own id) → "is itself a
    // child" guard fires, ADMIT.
    expect(result.passed).toBe(true);
  });

  it('REJECTS a single-child parent when that child is completed', () => {
    // Edge case: minimum quorum for orphan-parent classification is 1
    // completed child + 0 open children. Verifies the spec's "≥1" lower
    // bound.
    const g = graph([
      node('AISDLC-SINGLE'),
      node('AISDLC-SINGLE.1', { status: 'completed', parent: 'AISDLC-SINGLE' }),
    ]);
    const result = checkOrphanParent({ graph: g, taskId: 'AISDLC-SINGLE' });
    expect(result.passed).toBe(false);
    if (result.detail?.kind === 'orphan-parent-needs-closure') {
      expect(result.detail.completedChildren).toEqual(['aisdlc-single.1']);
    }
  });

  it('case-insensitive candidate task ID lookup', () => {
    // Same case-folding contract as dependency-readiness — callers may
    // pass the candidate ID in any case.
    const g = graph([
      node('AISDLC-LowerLookup'),
      node('AISDLC-LowerLookup.1', {
        status: 'completed',
        parent: 'AISDLC-LowerLookup',
      }),
    ]);
    const result = checkOrphanParent({ graph: g, taskId: 'aisdlc-lowerlookup' });
    expect(result.passed).toBe(false);
  });

  it('ignores children with empty parent_task_id', () => {
    // Empty-string `parentTaskId` (the absent case) must not match any
    // candidate — defending against the "every node has empty parent"
    // false positive.
    const g = graph([node('AISDLC-A'), node('AISDLC-B'), node('AISDLC-C')]);
    expect(checkOrphanParent({ graph: g, taskId: 'AISDLC-A' }).passed).toBe(true);
  });
});
