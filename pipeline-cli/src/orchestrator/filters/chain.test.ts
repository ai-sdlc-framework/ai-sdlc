/**
 * Filter chain composer (RFC-0015 Phase 3 / AISDLC-169.3) tests.
 *
 * Covers:
 *   - All-pass chain: trace has 5 entries, `passed: true`, `failure: null`.
 *   - Short-circuits at filter 0 (orphan-parent → single entry in trace).
 *   - Short-circuits at filter 1 (dependency failure → no DoR/external/blocked read).
 *   - Short-circuits at filter 2 (DoR failure → no external/blocked read).
 *   - Short-circuits at filter 3 (external failure → no blocked in trace).
 *   - Short-circuits at filter 4 (blocked failure → all 5 in trace).
 *   - `formatFilterTrace` renders both the admit and the skip cases per the
 *     RFC §11 Phase 3 task spec's exact format.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatFilterTrace, runFilterChain } from './chain.js';
import type {
  DependencyGraph,
  DependencyNode,
  ExternalDependency,
} from '../../deps/dependency-graph.js';

function node(
  id: string,
  opts: {
    deps?: string[];
    ext?: ExternalDependency[];
    status?: 'open' | 'completed';
    parent?: string;
  } = {},
): DependencyNode {
  const status = opts.status ?? 'open';
  return {
    id,
    status,
    fileLocation: status,
    frontmatterStatus: status === 'completed' ? 'Done' : 'To Do',
    priority: '',
    title: id,
    dependencies: opts.deps ?? [],
    externalDependencies: opts.ext ?? [],
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

let tmp: string;
let logPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'phase3-chain-'));
  logPath = join(tmp, 'calibration.jsonl');
});

describe('runFilterChain — all-pass', () => {
  it('admits a candidate that clears all five filters', () => {
    const g = graph([node('AISDLC-READY')]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-READY',
      calibrationLogPath: logPath, // missing → DoR passes by default
    });
    expect(result.passed).toBe(true);
    expect(result.failure).toBeNull();
    expect(result.trace).toHaveLength(5);
    // AISDLC-175 prepended `OrphanParent` to the chain — cheapest +
    // most decisive filter runs first. AISDLC-223 appended `Blocked` last.
    expect(result.trace.map((r) => r.filter)).toEqual([
      'OrphanParent',
      'DependencyReadiness',
      'DorReadiness',
      'ExternalDependencies',
      'Blocked',
    ]);
    expect(result.trace.every((r) => r.passed)).toBe(true);
  });
});

describe('runFilterChain — short-circuit ordering', () => {
  it('rejects + stops at OrphanParent when the candidate is a parent with all children done', () => {
    const g = graph([
      node('AISDLC-PARENT'),
      node('AISDLC-PARENT.1', { status: 'completed', parent: 'AISDLC-PARENT' }),
    ]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-PARENT',
      calibrationLogPath: logPath,
    });
    expect(result.passed).toBe(false);
    expect(result.failure?.filter).toBe('OrphanParent');
    // Short-circuited at filter 0 → no downstream filters in trace.
    expect(result.trace).toHaveLength(1);
  });

  it('rejects + stops at DependencyReadiness when a dependency is open (no DoR/external in trace)', () => {
    const g = graph([node('AISDLC-OPEN'), node('AISDLC-DEP', { deps: ['AISDLC-OPEN'] })]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-DEP',
      calibrationLogPath: logPath,
    });
    expect(result.passed).toBe(false);
    expect(result.failure?.filter).toBe('DependencyReadiness');
    // OrphanParent passed (filter 0), DependencyReadiness failed (filter 1).
    expect(result.trace).toHaveLength(2);
    expect(result.trace[0].filter).toBe('OrphanParent');
    expect(result.trace[0].passed).toBe(true);
  });

  it('rejects + stops at DorReadiness when the verdict blocks (no external in trace)', () => {
    writeFileSync(
      logPath,
      JSON.stringify({
        ts: '2026-05-02T12:00:00Z',
        issueId: 'AISDLC-X',
        rubricVersion: 'v1',
        evaluatorVersion: 't',
        overallVerdict: 'needs-clarification',
        failedGates: [4],
        outcome: '',
        verdict: {
          issueId: 'AISDLC-X',
          rubricVersion: 'v1',
          overallVerdict: 'needs-clarification',
          gates: [],
          signedAt: '2026-05-02T12:00:00Z',
          evaluatorVersion: 't',
        },
      }) + '\n',
    );
    const g = graph([node('AISDLC-X')]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-X',
      calibrationLogPath: logPath,
    });
    expect(result.passed).toBe(false);
    expect(result.failure?.filter).toBe('DorReadiness');
    expect(result.trace).toHaveLength(3);
    expect(result.trace[0].filter).toBe('OrphanParent');
    expect(result.trace[0].passed).toBe(true);
    expect(result.trace[1].filter).toBe('DependencyReadiness');
    expect(result.trace[1].passed).toBe(true);
    expect(result.trace[2].passed).toBe(false);
  });

  it('rejects at ExternalDependencies when an external manual dep is unresolved (short-circuits before Blocked)', () => {
    const g = graph([
      node('AISDLC-X', {
        ext: [{ id: 'sec-review', description: 'wait', kind: 'manual' }],
      }),
    ]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-X',
      calibrationLogPath: logPath,
    });
    expect(result.passed).toBe(false);
    expect(result.failure?.filter).toBe('ExternalDependencies');
    // OrphanParent + DependencyReadiness + DorReadiness + ExternalDependencies (fails).
    // Blocked filter is NOT in the trace because the chain short-circuited.
    expect(result.trace).toHaveLength(4);
    expect(result.trace[0].passed).toBe(true);
    expect(result.trace[1].passed).toBe(true);
    expect(result.trace[2].passed).toBe(true);
    expect(result.trace[3].passed).toBe(false);
  });

  it('rejects at Blocked when taskBlocked.reason is set (full trace of 5 entries)', () => {
    const g = graph([node('AISDLC-BLOCKED')]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-BLOCKED',
      calibrationLogPath: logPath,
      taskBlocked: { reason: 'Soaking — promotion gated on evidence' },
    });
    expect(result.passed).toBe(false);
    expect(result.failure?.filter).toBe('Blocked');
    // All 5 filters in trace, only last one fails.
    expect(result.trace).toHaveLength(5);
    expect(result.trace[0].filter).toBe('OrphanParent');
    expect(result.trace[0].passed).toBe(true);
    expect(result.trace[4].filter).toBe('Blocked');
    expect(result.trace[4].passed).toBe(false);
    expect(result.trace[4].reason).toBe('Soaking — promotion gated on evidence');
  });
});

describe('formatFilterTrace', () => {
  it('renders the all-pass case with the → admitted footer', () => {
    const g = graph([node('AISDLC-READY')]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-READY',
      calibrationLogPath: logPath,
    });
    const text = formatFilterTrace('AISDLC-READY', result);
    expect(text).toContain('[orchestrator] filter trace for AISDLC-READY:');
    expect(text).toContain('Orphan-parent check: passed');
    expect(text).toContain('Dependency check: passed');
    expect(text).toContain('DoR readiness: passed');
    expect(text).toContain('External deps: passed');
    expect(text).toContain('Operator-blocked check: passed');
    expect(text).toContain('→ admitted');
  });

  it('renders the orphan-parent case with the → skipped, orphan parent needs closure footer', () => {
    const g = graph([
      node('AISDLC-PARENT'),
      node('AISDLC-PARENT.1', { status: 'completed', parent: 'AISDLC-PARENT' }),
    ]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-PARENT',
      calibrationLogPath: logPath,
    });
    const text = formatFilterTrace('AISDLC-PARENT', result);
    expect(text).toContain('Orphan-parent check: failed');
    expect(text).toContain('→ skipped, orphan parent needs closure');
  });

  it('renders the external-await case with the → skipped, awaiting external footer (matches the task-spec exemplar)', () => {
    const g = graph([
      node('AISDLC-X', {
        ext: [{ id: 'npm-foo-2.0', description: 'wait', kind: 'manual' }],
      }),
    ]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-X',
      calibrationLogPath: logPath,
    });
    const text = formatFilterTrace('AISDLC-X', result);
    expect(text).toContain('External deps: failed');
    expect(text).toContain('→ skipped, awaiting external');
  });

  it('renders the dependency-blocked case', () => {
    const g = graph([node('AISDLC-OPEN'), node('AISDLC-X', { deps: ['AISDLC-OPEN'] })]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-X',
      calibrationLogPath: logPath,
    });
    const text = formatFilterTrace('AISDLC-X', result);
    expect(text).toContain('Dependency check: failed');
    expect(text).toContain('→ skipped, awaiting dependency');
  });

  it('renders the DoR-blocked case', () => {
    writeFileSync(
      logPath,
      JSON.stringify({
        ts: '2026-05-02T12:00:00Z',
        issueId: 'AISDLC-X',
        rubricVersion: 'v1',
        evaluatorVersion: 't',
        overallVerdict: 'needs-clarification',
        failedGates: [4],
        outcome: '',
        verdict: {
          issueId: 'AISDLC-X',
          rubricVersion: 'v1',
          overallVerdict: 'needs-clarification',
          gates: [],
          signedAt: '2026-05-02T12:00:00Z',
          evaluatorVersion: 't',
        },
      }) + '\n',
    );
    const g = graph([node('AISDLC-X')]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-X',
      calibrationLogPath: logPath,
    });
    const text = formatFilterTrace('AISDLC-X', result);
    expect(text).toContain('DoR readiness: failed');
    expect(text).toContain('→ skipped, awaiting DoR clarification');
  });
});
