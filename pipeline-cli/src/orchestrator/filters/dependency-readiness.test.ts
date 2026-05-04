/**
 * Filter 1 — dependency readiness (RFC-0015 Phase 3 / AISDLC-169.3) tests.
 *
 * Covers:
 *   - Empty blockers → passed.
 *   - Non-empty blockers → failed + structured detail.
 *   - Unknown task ID → passed (defensive: missing nodes have no blockers).
 *   - Blocker IDs are lowercased + ordered for the event payload.
 */

import { describe, expect, it } from 'vitest';
import { checkDependencyReadiness } from './dependency-readiness.js';
import type { DependencyGraph, DependencyNode } from '../../deps/dependency-graph.js';

function node(
  id: string,
  deps: string[] = [],
  status: 'open' | 'completed' = 'open',
): DependencyNode {
  return {
    id,
    status,
    fileLocation: status,
    frontmatterStatus: status === 'completed' ? 'Done' : 'To Do',
    priority: '',
    title: id,
    dependencies: deps,
    externalDependencies: [],
    lastModified: '2026-05-02T00:00:00Z',
    filePath: `/tmp/${id}.md`,
    parentTaskId: '',
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

describe('checkDependencyReadiness', () => {
  it('passes when the candidate has no upstream blockers', () => {
    const g = graph([node('AISDLC-A')]);
    const result = checkDependencyReadiness({ graph: g, taskId: 'AISDLC-A' });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('DependencyReadiness');
    expect(result.detail).toBeUndefined();
  });

  it('passes when every upstream task is completed', () => {
    const g = graph([node('AISDLC-DONE', [], 'completed'), node('AISDLC-DEP', ['AISDLC-DONE'])]);
    const result = checkDependencyReadiness({ graph: g, taskId: 'AISDLC-DEP' });
    expect(result.passed).toBe(true);
  });

  it('fails when any upstream task is still open', () => {
    const g = graph([node('AISDLC-OPEN'), node('AISDLC-DEP', ['AISDLC-OPEN'])]);
    const result = checkDependencyReadiness({ graph: g, taskId: 'AISDLC-DEP' });
    expect(result.passed).toBe(false);
    expect(result.detail).toEqual({ kind: 'dependency-blocked', blockers: ['aisdlc-open'] });
    expect(result.reason).toContain('aisdlc-open');
  });

  it('walks transitive blockers (B blocks A which blocks the candidate)', () => {
    const g = graph([
      node('AISDLC-A'),
      node('AISDLC-B', ['AISDLC-A']),
      node('AISDLC-DEP', ['AISDLC-B']),
    ]);
    const result = checkDependencyReadiness({ graph: g, taskId: 'AISDLC-DEP' });
    expect(result.passed).toBe(false);
    expect(result.detail?.kind).toBe('dependency-blocked');
    if (result.detail?.kind === 'dependency-blocked') {
      // Transitive closure surfaces both A and B as blockers.
      expect(result.detail.blockers.sort()).toEqual(['aisdlc-a', 'aisdlc-b']);
    }
  });

  it('passes when the task ID is unknown to the graph (defensive)', () => {
    const g = graph([]);
    const result = checkDependencyReadiness({ graph: g, taskId: 'AISDLC-UNKNOWN' });
    expect(result.passed).toBe(true);
  });

  it('case-insensitive task ID lookup', () => {
    const g = graph([node('AISDLC-Mixed', ['AISDLC-OPEN']), node('AISDLC-OPEN')]);
    const result = checkDependencyReadiness({ graph: g, taskId: 'aisdlc-mixed' });
    expect(result.passed).toBe(false);
  });
});
