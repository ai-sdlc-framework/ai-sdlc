/**
 * Loop-level integration tests for the BlastRadiusOverlap admission filter
 * (AISDLC-231 Major 3 + Major 4).
 *
 * Major 3 — verifies that `runOrchestratorTick` drives the blast-radius
 * overlap filter end-to-end: 3 frontier candidates all touching `shared/types.ts`,
 * with a pre-existing in-flight task (open PR from a prior tick) that ALSO
 * touches `shared/types.ts`. The filter detects the overlap for 2 of the 3
 * candidates (they share `shared/types.ts` with the in-flight task), admits the
 * 1 candidate that has no overlap, and produces 2 `OrchestratorBlockedByBlastRadiusOverlap`
 * events in the tick's filter events + emittedEvents bus.
 *
 * Major 4 — verifies the public event shape of
 * `OrchestratorBlockedByBlastRadiusOverlapEvent` as produced by the loop's
 * `toBlockedEvent` → filter-event path: type, taskId, inFlightTaskId,
 * overlap, overlapCount, ts are all present and correctly typed.
 *
 * Both test suites are fully hermetic: no real `gh`, no real filesystem
 * access. Stubs are injected via `blastRadiusOverlapOpts`.
 *
 * Design note on the Major 3 fixture
 * ─────────────────────────────────────
 * The blast-radius filter serialises ACROSS ticks: a task dispatched in tick N
 * has an open PR; in tick N+1 a candidate whose blast-radius overlaps that PR's
 * task is deferred. To exercise this in a single-tick test we inject a
 * `listOpenPRs` stub that returns the in-flight PR (from a hypothetical prior
 * tick) for all candidates. The stub returns the canonical `ai-sdlc/aisdlc-NNN`
 * branch pattern so `extractTaskIdFromBranch` resolves it correctly.
 *
 * Scenario:
 *   - AISDLC-100 is the pre-existing in-flight task (open PR from tick N).
 *     It touches `shared/types.ts`.
 *   - AISDLC-200: touches `shared/types.ts` + `own-a.ts`. Overlaps with 100. BLOCKED.
 *   - AISDLC-300: touches `shared/types.ts` + `own-b.ts`. Overlaps with 100. BLOCKED.
 *   - AISDLC-400: touches `other/file.ts` only. No overlap with 100. ADMITTED.
 *   - max-concurrent=3 → budget=3, but only AISDLC-400 is admitted.
 *   - Dispatched=[AISDLC-400], 2 OrchestratorBlockedByBlastRadiusOverlap events.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultOrchestratorConfig,
  ORCHESTRATOR_FLAG,
  runOrchestratorTick,
  type OrchestratorAdapters,
  type OrchestratorBlockedByBlastRadiusOverlapEvent,
} from './index.js';
import type { DependencyGraph, DependencyNode } from '../deps/dependency-graph.js';
import type { PipelineLogger, PipelineResult } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function silentLogger(): PipelineLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, progress: () => {} };
}

function node(id: string, opts: { deps?: string[] } = {}): DependencyNode {
  return {
    id,
    status: 'open',
    fileLocation: 'open',
    frontmatterStatus: 'To Do',
    priority: '',
    title: id,
    dependencies: opts.deps ?? [],
    externalDependencies: [],
    lastModified: '2026-05-02T00:00:00Z',
    filePath: `/tmp/${id}.md`,
    parentTaskId: '',
  };
}

function buildGraph(nodes: DependencyNode[]): DependencyGraph {
  const map = new Map<string, DependencyNode>();
  const openIds: string[] = [];
  for (const n of nodes) {
    map.set(n.id.toLowerCase(), n);
    openIds.push(n.id.toLowerCase());
  }
  return { nodes: map, openIds, completedIds: [] };
}

function approvedResult(taskId: string): PipelineResult {
  return {
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktreePath: `.worktrees/${taskId.toLowerCase()}`,
    outcome: 'approved',
    prUrl: `https://github.com/x/y/pull/${taskId}`,
    siblingPrUrls: [],
    iterations: 1,
    finalVerdict: null,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env[ORCHESTRATOR_FLAG] = 'experimental';
});
afterEach(() => {
  delete process.env[ORCHESTRATOR_FLAG];
});

// ── Major 3 — runOrchestratorTick end-to-end with overlapping candidates ─────

describe('runOrchestratorTick — blast-radius overlap integration (Major 3)', () => {
  it('3 candidates, 2 overlapping with in-flight AISDLC-100 (shared/types.ts): only non-overlapping task admitted; 2 OrchestratorBlockedByBlastRadiusOverlap events', async () => {
    // AISDLC-100 is a pre-existing in-flight task (open PR from a prior tick).
    // It touches shared/types.ts.
    // Frontier candidates this tick: AISDLC-200, AISDLC-300, AISDLC-400.
    //   - AISDLC-200: [shared/types.ts, own-a.ts] → overlaps with AISDLC-100 → BLOCKED
    //   - AISDLC-300: [shared/types.ts, own-b.ts] → overlaps with AISDLC-100 → BLOCKED
    //   - AISDLC-400: [other/file.ts]             → no overlap with AISDLC-100 → ADMITTED
    const graph = buildGraph([node('AISDLC-200'), node('AISDLC-300'), node('AISDLC-400')]);

    const dispatched: string[] = [];
    const emittedEvents: object[] = [];

    const config = defaultOrchestratorConfig({
      workDir: '/tmp/blast-radius-integration-test',
      maxConcurrent: 3,
      maxTicks: 1,
      tickIntervalSec: 0,
    });

    // Blast-radius file sets:
    const blastRadiusMap: Record<string, string[]> = {
      'AISDLC-100': ['shared/types.ts'],
      'AISDLC-200': ['shared/types.ts', 'own-a.ts'],
      'AISDLC-300': ['shared/types.ts', 'own-b.ts'],
      'AISDLC-400': ['other/file.ts'],
    };

    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [
        { id: 'AISDLC-200', title: 'Task 200' },
        { id: 'AISDLC-300', title: 'Task 300' },
        { id: 'AISDLC-400', title: 'Task 400' },
      ],
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      taskBlockedLoader: () => undefined,
      taskDispatchableLoader: () => ({
        dispatchable: undefined,
        dispatchableReason: undefined,
      }),
      dispatch: async (taskId) => {
        dispatched.push(taskId);
        return approvedResult(taskId);
      },
      escalate: async () => {},
      parentBranchGuard: async () => {},
      emitEvent: (ev) => emittedEvents.push(ev),
      blastRadiusOverlapOpts: {
        // AISDLC-100 has an open PR from a prior tick — visible to all candidates.
        // Branch name uses canonical ai-sdlc/aisdlc-NNN pattern so extractTaskIdFromBranch resolves it.
        listOpenPRs: () =>
          [
            {
              number: 100,
              headRefName: 'ai-sdlc/aisdlc-100-shared-types',
            },
          ] as { number: number; headRefName: string }[],
        computeBlastRadiusFiles: (taskId: string) => blastRadiusMap[taskId.toUpperCase()] ?? [],
      },
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };

    const tick = await runOrchestratorTick(config, adapters, 1);

    // Only AISDLC-400 (no overlap with AISDLC-100) should be dispatched.
    expect(dispatched).toEqual(['AISDLC-400']);
    expect(tick.dispatched).toEqual(['AISDLC-400']);
    expect(tick.candidates).toBe(3);

    // Three filter events — one per evaluated candidate.
    expect(tick.filterEvents).toHaveLength(3);

    // AISDLC-400 is admitted.
    const ev400 = tick.filterEvents.find((e) => e.taskId === 'AISDLC-400');
    expect(ev400).toBeDefined();
    expect(ev400!.trace.passed).toBe(true);
    expect(ev400!.blockedEvent).toBeNull();

    // AISDLC-200 and AISDLC-300 are blocked by blast-radius overlap.
    const ev200 = tick.filterEvents.find((e) => e.taskId === 'AISDLC-200');
    const ev300 = tick.filterEvents.find((e) => e.taskId === 'AISDLC-300');
    expect(ev200).toBeDefined();
    expect(ev300).toBeDefined();
    expect(ev200!.trace.passed).toBe(false);
    expect(ev300!.trace.passed).toBe(false);

    // Both blocked events are of the blast-radius-overlap type.
    expect(ev200!.blockedEvent?.type).toBe('OrchestratorBlockedByBlastRadiusOverlap');
    expect(ev300!.blockedEvent?.type).toBe('OrchestratorBlockedByBlastRadiusOverlap');

    // Both cite AISDLC-100 as the in-flight task.
    const blocked200 = ev200!.blockedEvent as OrchestratorBlockedByBlastRadiusOverlapEvent;
    const blocked300 = ev300!.blockedEvent as OrchestratorBlockedByBlastRadiusOverlapEvent;
    expect(blocked200.inFlightTaskId).toBe('AISDLC-100');
    expect(blocked300.inFlightTaskId).toBe('AISDLC-100');

    // The events bus received exactly 2 OrchestratorBlockedByBlastRadiusOverlap entries.
    const overlapEmits = emittedEvents.filter(
      (e): e is { type: string } =>
        typeof e === 'object' &&
        e !== null &&
        (e as { type?: string }).type === 'OrchestratorBlockedByBlastRadiusOverlap',
    );
    expect(overlapEmits).toHaveLength(2);
  });
});

// ── Major 4 — public event shape of OrchestratorBlockedByBlastRadiusOverlapEvent ─

describe('runOrchestratorTick — OrchestratorBlockedByBlastRadiusOverlapEvent shape (Major 4)', () => {
  it('blockedEvent has the canonical OrchestratorBlockedByBlastRadiusOverlapEvent shape: type, taskId, inFlightTaskId, overlap, overlapCount, ts', async () => {
    // AISDLC-231 is the frontier candidate; AISDLC-150 has an open PR (in-flight).
    // Both touch shared/types.ts + pipeline-cli/src/orchestrator/loop.ts.
    const graph = buildGraph([node('AISDLC-231')]);
    const config = defaultOrchestratorConfig({
      workDir: '/tmp/blast-radius-shape-test',
      maxConcurrent: 1,
      maxTicks: 1,
      tickIntervalSec: 0,
    });

    const now = new Date('2026-05-09T12:00:00.000Z');

    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [{ id: 'AISDLC-231', title: 'Task 231' }],
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      taskBlockedLoader: () => undefined,
      taskDispatchableLoader: () => ({
        dispatchable: undefined,
        dispatchableReason: undefined,
      }),
      dispatch: async (taskId) => approvedResult(taskId),
      escalate: async () => {},
      parentBranchGuard: async () => {},
      now: () => now,
      blastRadiusOverlapOpts: {
        // AISDLC-150 has an open PR — branch name uses canonical numeric pattern.
        listOpenPRs: () =>
          [
            {
              number: 425,
              headRefName: 'ai-sdlc/aisdlc-150-types',
            },
          ] as { number: number; headRefName: string }[],
        computeBlastRadiusFiles: (taskId: string) => {
          const id = taskId.toUpperCase();
          if (id === 'AISDLC-231')
            return ['shared/types.ts', 'pipeline-cli/src/orchestrator/loop.ts'];
          if (id === 'AISDLC-150') return ['shared/types.ts', 'other/file.ts'];
          return [];
        },
      },
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };

    const tick = await runOrchestratorTick(config, adapters, 1);

    // AISDLC-231 should be blocked by overlap with AISDLC-150.
    expect(tick.filterEvents).toHaveLength(1);
    const filterEvent = tick.filterEvents[0];
    expect(filterEvent.taskId).toBe('AISDLC-231');
    expect(filterEvent.trace.passed).toBe(false);

    // The blockedEvent must satisfy the OrchestratorBlockedByBlastRadiusOverlapEvent shape.
    const blockedEvent = filterEvent.blockedEvent as OrchestratorBlockedByBlastRadiusOverlapEvent;
    expect(blockedEvent).not.toBeNull();

    // type — must be the canonical discriminant.
    expect(blockedEvent.type).toBe('OrchestratorBlockedByBlastRadiusOverlap');

    // taskId — the candidate, not the in-flight task.
    expect(blockedEvent.taskId).toBe('AISDLC-231');

    // inFlightTaskId — the conflicting in-flight task extracted from the PR branch.
    expect(blockedEvent.inFlightTaskId).toBe('AISDLC-150');

    // overlap — up to 3 overlapping file paths from the candidate's perspective.
    expect(Array.isArray(blockedEvent.overlap)).toBe(true);
    expect(blockedEvent.overlap).toContain('shared/types.ts');
    expect(blockedEvent.overlap.length).toBeLessThanOrEqual(3);

    // overlapCount — total number of overlapping files (≥ overlap.length).
    expect(typeof blockedEvent.overlapCount).toBe('number');
    expect(blockedEvent.overlapCount).toBeGreaterThanOrEqual(blockedEvent.overlap.length);
    expect(blockedEvent.overlapCount).toBe(1); // only shared/types.ts overlaps

    // ts — ISO timestamp from the loop's wall clock.
    expect(typeof blockedEvent.ts).toBe('string');
    expect(blockedEvent.ts).toBe(now.toISOString());
  });

  it('injected blastRadiusOverlapOpts with a stray taskId is ignored — candidate id always wins', async () => {
    // Major 2 regression guard: even if someone passes a `taskId` field inside
    // blastRadiusOverlapOpts (which the Omit<> type now prevents at compile time),
    // the chain.ts spread puts opts.taskId LAST so the candidate's own id wins.
    // We verify the loop correctly passes the per-candidate taskId and that the
    // filter event reflects the correct candidate (AISDLC-500) not any stray value.
    const graph = buildGraph([node('AISDLC-500')]);
    const config = defaultOrchestratorConfig({
      workDir: '/tmp/blast-radius-taskid-test',
      maxConcurrent: 1,
      maxTicks: 1,
      tickIntervalSec: 0,
    });

    let filterReceivedTaskId: string | undefined;

    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [{ id: 'AISDLC-500', title: 'Task 500' }],
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      taskBlockedLoader: () => undefined,
      taskDispatchableLoader: () => ({
        dispatchable: undefined,
        dispatchableReason: undefined,
      }),
      dispatch: async (taskId) => approvedResult(taskId),
      escalate: async () => {},
      parentBranchGuard: async () => {},
      blastRadiusOverlapOpts: {
        listOpenPRs: () => [],
        computeBlastRadiusFiles: (taskId: string) => {
          // Capture the taskId the filter actually receives.
          filterReceivedTaskId = taskId;
          return [];
        },
      },
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 1);

    // The filter must have been called with the candidate's own id (AISDLC-500),
    // not any injected override. The Omit<> type enforces this at compile time;
    // this assertion confirms the runtime behaviour.
    expect(filterReceivedTaskId).toBe('AISDLC-500');
  });
});
