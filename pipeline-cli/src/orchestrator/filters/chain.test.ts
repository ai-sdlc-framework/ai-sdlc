/**
 * Filter chain composer (RFC-0015 Phase 3 / AISDLC-169.3) tests.
 *
 * Covers:
 *   - All-pass chain: trace has 10 entries (9 filters + CapturesPending),
 *     `passed: true`, `failure: null`.
 *   - Short-circuits at filter -1 (OpenPullRequestExists → 1 entry in trace).
 *   - Short-circuits at filter 0 (orphan-parent → 2 entries in trace).
 *   - Short-circuits at filter 0.5 (already-in-flight → 3 entries in trace).
 *   - Short-circuits at filter 1 (dependency failure → 4 entries; blast-radius
 *     overlap never runs because dep is the prior gate in the new order).
 *   - Short-circuits at filter 1.5 (blast-radius-overlap → 5 entries in trace).
 *   - Short-circuits at filter 3 (DoR failure → no external/blocked read).
 *   - Short-circuits at filter 4 (external failure → no blocked in trace).
 *   - Short-circuits at filter 5 (blocked failure → all 9 in trace before CapturesPending).
 *   - `formatFilterTrace` renders both the admit and the skip cases per the
 *     RFC §11 Phase 3 task spec's exact format.
 *
 * AISDLC-361 — `OpenPullRequestExists` is the FIRST filter in the chain.
 * All trace length assertions include this new entry at index 0. Tests that
 * don't specifically exercise the new filter inject `openPRExistsOpts` with
 * `listOpenPRsByBranch: () => []` (degrade-open / admitted) to stay hermetic
 * without real `gh` network calls.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatFilterTrace, runFilterChain } from './chain.js';
import type { RunFilterChainOpts } from './chain.js';
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
  it('admits a candidate that clears all nine filters', () => {
    const g = graph([node('AISDLC-READY')]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-READY',
      calibrationLogPath: logPath, // missing → DoR passes by default
      // AISDLC-361 — stub open-PR check: no PRs, filter passes.
      openPRExistsOpts: {
        listOpenPRsByBranch: () => [],
      },
      // Disable real gh/ps calls in tests.
      alreadyInFlightOpts: {
        listOpenPRs: () => [],
        readProcessTable: () => '',
        detectSubprocess: false,
      },
      // AISDLC-231 — stub blast-radius to empty (degrade-open) so the filter passes.
      blastRadiusOverlapOpts: {
        listOpenPRs: () => [],
        computeBlastRadiusFiles: () => [],
      },
    });
    expect(result.passed).toBe(true);
    expect(result.failure).toBeNull();
    expect(result.trace).toHaveLength(10);
    // AISDLC-361 prepended `OpenPullRequestExists`. AISDLC-175 added `OrphanParent`.
    // AISDLC-227 inserted `AlreadyInFlight` third. DependencyReadiness runs fourth
    // (before BlastRadiusOverlap so dep-blocked tasks report the dep failure, not
    // the overlap). AISDLC-231 inserted `BlastRadiusOverlap` fifth. AISDLC-243
    // inserted `Dispatchability` after BlastRadiusOverlap. AISDLC-223 appended
    // `Blocked` after ExternalDeps. RFC-0024 / AISDLC-269 appended `CapturesPending`
    // last (degrade-open when AI_SDLC_EMERGENT_CAPTURE is unset).
    expect(result.trace.map((r) => r.filter)).toEqual([
      'OpenPullRequestExists',
      'OrphanParent',
      'AlreadyInFlight',
      'DependencyReadiness',
      'BlastRadiusOverlap',
      'Dispatchability',
      'DorReadiness',
      'ExternalDependencies',
      'Blocked',
      'CapturesPending',
    ]);
    expect(result.trace.every((r) => r.passed)).toBe(true);
  });
});

/** Helper: build alreadyInFlightOpts that stubs out real gh/ps calls. */
function noInFlight(): RunFilterChainOpts['alreadyInFlightOpts'] {
  return { listOpenPRs: () => [], readProcessTable: () => '', detectSubprocess: false };
}

/**
 * Helper: build blastRadiusOverlapOpts that stubs out real gh/fs calls and
 * always returns an empty blast-radius (degrade-open → admitted). Used by
 * tests that are NOT specifically testing blast-radius overlap to keep them
 * hermetic and prevent traces from changing due to filter count.
 */
function noBlastRadius(): RunFilterChainOpts['blastRadiusOverlapOpts'] {
  return { listOpenPRs: () => [], computeBlastRadiusFiles: () => [] };
}

/**
 * Helper: build openPRExistsOpts that stubs out the real gh call and always
 * returns no open PRs (degrade-open / admitted). Used by tests that are NOT
 * specifically testing the OpenPullRequestExists filter to stay hermetic.
 * AISDLC-361.
 */
function noOpenPR(): RunFilterChainOpts['openPRExistsOpts'] {
  return { listOpenPRsByBranch: () => [] };
}

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
      openPRExistsOpts: noOpenPR(),
      alreadyInFlightOpts: noInFlight(),
    });
    expect(result.passed).toBe(false);
    expect(result.failure?.filter).toBe('OrphanParent');
    // OpenPullRequestExists passed (index 0), short-circuited at OrphanParent (index 1).
    expect(result.trace).toHaveLength(2);
    expect(result.trace[0].filter).toBe('OpenPullRequestExists');
    expect(result.trace[0].passed).toBe(true);
    expect(result.trace[1].filter).toBe('OrphanParent');
    expect(result.trace[1].passed).toBe(false);
  });

  it('rejects + stops at AlreadyInFlight when an open PR is detected', () => {
    const g = graph([node('AISDLC-202')]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-202',
      calibrationLogPath: logPath,
      openPRExistsOpts: noOpenPR(),
      alreadyInFlightOpts: {
        listOpenPRs: () => [{ number: 402 }],
        detectSubprocess: false,
      },
    });
    expect(result.passed).toBe(false);
    expect(result.failure?.filter).toBe('AlreadyInFlight');
    // OpenPullRequestExists passed (0), OrphanParent passed (1), AlreadyInFlight failed (2).
    expect(result.trace).toHaveLength(3);
    expect(result.trace[0].filter).toBe('OpenPullRequestExists');
    expect(result.trace[0].passed).toBe(true);
    expect(result.trace[1].filter).toBe('OrphanParent');
    expect(result.trace[1].passed).toBe(true);
    expect(result.trace[2].filter).toBe('AlreadyInFlight');
    expect(result.trace[2].passed).toBe(false);
  });

  it('rejects + stops at BlastRadiusOverlap (5 entries) — after Dep passes, before Dispatchability', () => {
    // Candidate has no open deps (dep check passes), but its blast-radius
    // overlaps an in-flight task.
    const g = graph([node('AISDLC-231')]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-231',
      calibrationLogPath: logPath,
      openPRExistsOpts: noOpenPR(),
      alreadyInFlightOpts: noInFlight(),
      blastRadiusOverlapOpts: {
        // Simulate: AISDLC-100 is in-flight and shares shared/types.ts.
        listOpenPRs: () =>
          [{ number: 400, headRefName: 'ai-sdlc/aisdlc-100-shared-types' }] as {
            number: number;
            headRefName: string;
          }[],
        computeBlastRadiusFiles: (taskId: string) => {
          if (taskId.toUpperCase() === 'AISDLC-231') return ['shared/types.ts'];
          if (taskId.toUpperCase() === 'AISDLC-100') return ['shared/types.ts'];
          return [];
        },
      },
    });
    expect(result.passed).toBe(false);
    expect(result.failure?.filter).toBe('BlastRadiusOverlap');
    // OpenPullRequestExists (0) + OrphanParent (1) + AlreadyInFlight (2) +
    // DependencyReadiness (3) passed; BlastRadiusOverlap (4) failed →
    // 5 entries total, Dispatchability never runs.
    expect(result.trace).toHaveLength(5);
    expect(result.trace[0].filter).toBe('OpenPullRequestExists');
    expect(result.trace[0].passed).toBe(true);
    expect(result.trace[1].filter).toBe('OrphanParent');
    expect(result.trace[1].passed).toBe(true);
    expect(result.trace[2].filter).toBe('AlreadyInFlight');
    expect(result.trace[2].passed).toBe(true);
    expect(result.trace[3].filter).toBe('DependencyReadiness');
    expect(result.trace[3].passed).toBe(true);
    expect(result.trace[4].filter).toBe('BlastRadiusOverlap');
    expect(result.trace[4].passed).toBe(false);
    expect(result.failure?.detail).toMatchObject({
      kind: 'blast-radius-overlap',
      inFlightTaskId: 'AISDLC-100',
      overlap: ['shared/types.ts'],
    });
  });

  it('rejects + stops at DependencyReadiness when a dependency is open (no BlastRadius/DoR/external in trace)', () => {
    const g = graph([node('AISDLC-OPEN'), node('AISDLC-DEP', { deps: ['AISDLC-OPEN'] })]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-DEP',
      calibrationLogPath: logPath,
      openPRExistsOpts: noOpenPR(),
      alreadyInFlightOpts: noInFlight(),
      blastRadiusOverlapOpts: noBlastRadius(),
    });
    expect(result.passed).toBe(false);
    expect(result.failure?.filter).toBe('DependencyReadiness');
    // OpenPullRequestExists passed (0), OrphanParent passed (1),
    // AlreadyInFlight passed (2), DependencyReadiness failed (3) —
    // BlastRadiusOverlap never runs because the chain short-circuits first.
    expect(result.trace).toHaveLength(4);
    expect(result.trace[0].filter).toBe('OpenPullRequestExists');
    expect(result.trace[0].passed).toBe(true);
    expect(result.trace[1].filter).toBe('OrphanParent');
    expect(result.trace[1].passed).toBe(true);
    expect(result.trace[2].filter).toBe('AlreadyInFlight');
    expect(result.trace[2].passed).toBe(true);
    expect(result.trace[3].filter).toBe('DependencyReadiness');
    expect(result.trace[3].passed).toBe(false);
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
      openPRExistsOpts: noOpenPR(),
      alreadyInFlightOpts: noInFlight(),
      blastRadiusOverlapOpts: noBlastRadius(),
    });
    expect(result.passed).toBe(false);
    expect(result.failure?.filter).toBe('DorReadiness');
    // OpenPullRequestExists + OrphanParent + AlreadyInFlight + DependencyReadiness
    // + BlastRadiusOverlap + Dispatchability (passed) + DorReadiness (failed).
    // ExternalDependencies is NOT in the trace.
    expect(result.trace).toHaveLength(7);
    expect(result.trace[0].filter).toBe('OpenPullRequestExists');
    expect(result.trace[0].passed).toBe(true);
    expect(result.trace[1].filter).toBe('OrphanParent');
    expect(result.trace[1].passed).toBe(true);
    expect(result.trace[2].filter).toBe('AlreadyInFlight');
    expect(result.trace[2].passed).toBe(true);
    expect(result.trace[3].filter).toBe('DependencyReadiness');
    expect(result.trace[3].passed).toBe(true);
    expect(result.trace[4].filter).toBe('BlastRadiusOverlap');
    expect(result.trace[4].passed).toBe(true);
    expect(result.trace[5].filter).toBe('Dispatchability');
    expect(result.trace[5].passed).toBe(true);
    expect(result.trace[6].filter).toBe('DorReadiness');
    expect(result.trace[6].passed).toBe(false);
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
      openPRExistsOpts: noOpenPR(),
      alreadyInFlightOpts: noInFlight(),
      blastRadiusOverlapOpts: noBlastRadius(),
    });
    expect(result.passed).toBe(false);
    expect(result.failure?.filter).toBe('ExternalDependencies');
    // OpenPullRequestExists + OrphanParent + AlreadyInFlight + DependencyReadiness
    // + BlastRadiusOverlap + Dispatchability + DorReadiness + ExternalDependencies
    // (fails). Blocked is NOT in the trace.
    expect(result.trace).toHaveLength(8);
    expect(result.trace[0].passed).toBe(true);
    expect(result.trace[1].passed).toBe(true);
    expect(result.trace[2].passed).toBe(true);
    expect(result.trace[3].passed).toBe(true);
    expect(result.trace[4].passed).toBe(true);
    expect(result.trace[5].passed).toBe(true);
    expect(result.trace[6].passed).toBe(true);
    expect(result.trace[7].passed).toBe(false);
  });

  it('rejects at Blocked when taskBlocked.reason is set (full trace of 9 entries before CapturesPending)', () => {
    const g = graph([node('AISDLC-BLOCKED')]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-BLOCKED',
      calibrationLogPath: logPath,
      taskBlocked: { reason: 'Soaking — promotion gated on evidence' },
      openPRExistsOpts: noOpenPR(),
      alreadyInFlightOpts: noInFlight(),
      blastRadiusOverlapOpts: noBlastRadius(),
    });
    expect(result.passed).toBe(false);
    expect(result.failure?.filter).toBe('Blocked');
    // All 9 filters in trace: OpenPullRequestExists (0), OrphanParent (1),
    // AlreadyInFlight (2), DependencyReadiness (3), BlastRadiusOverlap (4),
    // Dispatchability (5), DorReadiness (6), ExternalDependencies (7),
    // Blocked (8 — fails). CapturesPending never runs because Blocked short-circuits.
    expect(result.trace).toHaveLength(9);
    expect(result.trace[0].filter).toBe('OpenPullRequestExists');
    expect(result.trace[0].passed).toBe(true);
    expect(result.trace[1].filter).toBe('OrphanParent');
    expect(result.trace[1].passed).toBe(true);
    expect(result.trace[2].filter).toBe('AlreadyInFlight');
    expect(result.trace[2].passed).toBe(true);
    expect(result.trace[3].filter).toBe('DependencyReadiness');
    expect(result.trace[3].passed).toBe(true);
    expect(result.trace[4].filter).toBe('BlastRadiusOverlap');
    expect(result.trace[4].passed).toBe(true);
    expect(result.trace[8].filter).toBe('Blocked');
    expect(result.trace[8].passed).toBe(false);
    expect(result.trace[8].reason).toBe('Soaking — promotion gated on evidence');
  });
});

describe('formatFilterTrace', () => {
  it('renders the all-pass case with the → admitted footer', () => {
    const g = graph([node('AISDLC-READY')]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-READY',
      calibrationLogPath: logPath,
      alreadyInFlightOpts: noInFlight(),
      blastRadiusOverlapOpts: noBlastRadius(),
    });
    const text = formatFilterTrace('AISDLC-READY', result);
    expect(text).toContain('[orchestrator] filter trace for AISDLC-READY:');
    expect(text).toContain('Orphan-parent check: passed');
    expect(text).toContain('Already-in-flight check: passed');
    expect(text).toContain('Blast-radius overlap check: passed');
    expect(text).toContain('Dependency check: passed');
    expect(text).toContain('Dispatchability check: passed');
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
      alreadyInFlightOpts: noInFlight(),
      blastRadiusOverlapOpts: noBlastRadius(),
    });
    const text = formatFilterTrace('AISDLC-PARENT', result);
    expect(text).toContain('Orphan-parent check: failed');
    expect(text).toContain('→ skipped, orphan parent needs closure');
  });

  it('renders the already-in-flight (open PR) case', () => {
    const g = graph([node('AISDLC-202')]);
    const result = runFilterChain({
      graph: g,
      taskId: 'AISDLC-202',
      calibrationLogPath: logPath,
      alreadyInFlightOpts: {
        listOpenPRs: () => [{ number: 402 }],
        detectSubprocess: false,
      },
      blastRadiusOverlapOpts: noBlastRadius(),
    });
    const text = formatFilterTrace('AISDLC-202', result);
    expect(text).toContain('Already-in-flight check: failed');
    expect(text).toContain('PR #402');
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
      alreadyInFlightOpts: noInFlight(),
      blastRadiusOverlapOpts: noBlastRadius(),
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
      alreadyInFlightOpts: noInFlight(),
      blastRadiusOverlapOpts: noBlastRadius(),
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
      alreadyInFlightOpts: noInFlight(),
      blastRadiusOverlapOpts: noBlastRadius(),
    });
    const text = formatFilterTrace('AISDLC-X', result);
    expect(text).toContain('DoR readiness: failed');
    expect(text).toContain('→ skipped, awaiting DoR clarification');
  });
});
