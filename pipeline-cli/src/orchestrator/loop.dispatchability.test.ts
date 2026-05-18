/**
 * Hermetic integration test for the Dispatchability filter (AISDLC-243).
 *
 * AC #7: backlog with 1 dispatchable + 1 non-dispatchable task → tick admits
 * only the dispatchable task; the filter event for the other has
 * `reason: dispatchableReason` (i.e. the blocked event type is
 * `OrchestratorBlockedByDispatchability`).
 *
 * Also covers:
 *   - Non-dispatchable task still appears in the frontier (it IS ready by
 *     dependency criteria); the Dispatchability filter is the only gate.
 *   - Filter trace includes the Dispatchability filter entry for the
 *     non-dispatchable task (even though the chain short-circuits before DoR).
 *   - Admitted task's filter trace does NOT include a Dispatchability failure.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  defaultOrchestratorConfig,
  runOrchestratorTick,
  ORCHESTRATOR_FLAG,
  type OrchestratorAdapters,
} from './index.js';
import type { DependencyGraph, DependencyNode } from '../deps/dependency-graph.js';
import type { PipelineResult, PipelineLogger } from '../types.js';
import type { OrchestratorBlockedByDispatchabilityEvent } from './types.js';

// ── Helpers ───────────────────────────────────────────────────────────

function silentLogger(): PipelineLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, progress: () => {} };
}

function node(
  id: string,
  opts: { deps?: string[]; status?: 'open' | 'completed' } = {},
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
    externalDependencies: [],
    lastModified: '2026-05-07T00:00:00Z',
    filePath: `/tmp/${id}.md`,
    parentTaskId: '',
  };
}

function buildGraph(nodes: DependencyNode[]): DependencyGraph {
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

beforeEach(() => {
  process.env[ORCHESTRATOR_FLAG] = 'experimental';
});
afterEach(() => {
  delete process.env[ORCHESTRATOR_FLAG];
});

// ── AC #7 hermetic integration test ──────────────────────────────────

describe('runOrchestratorTick — Dispatchability filter (AISDLC-243)', () => {
  it('AC #7: dispatches only the dispatchable task; emits OrchestratorBlockedByDispatchability for the other', async () => {
    const graph = buildGraph([node('AISDLC-OK'), node('AISDLC-SOAK')]);

    const dispatched: string[] = [];
    const config = defaultOrchestratorConfig({
      workDir: '/tmp/dispatchability-test',
      maxConcurrent: 2,
      maxTicks: 1,
      tickIntervalSec: 0,
    });

    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [
        { id: 'AISDLC-OK', title: 'A dispatchable task' },
        { id: 'AISDLC-SOAK', title: 'A soak phase task' },
      ],
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      // AISDLC-243 — inject dispatchable flags directly (no file I/O in test).
      taskDispatchableLoader: (taskId) => {
        if (taskId === 'AISDLC-SOAK') {
          return {
            dispatchable: false,
            dispatchableReason: 'Operator soak phase — no code work',
          };
        }
        // AISDLC-OK has no dispatchable field → treated as true.
        return { dispatchable: undefined, dispatchableReason: undefined };
      },
      dispatch: async (taskId) => {
        dispatched.push(taskId);
        return approvedResult(taskId);
      },
      escalate: async () => {},
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };

    const tick = await runOrchestratorTick(config, adapters, 1);

    // Only the dispatchable task was dispatched.
    expect(dispatched).toEqual(['AISDLC-OK']);
    expect(tick.dispatched).toEqual(['AISDLC-OK']);
    expect(tick.candidates).toBe(2);

    // Two filter events — one per evaluated candidate.
    expect(tick.filterEvents).toHaveLength(2);

    // AISDLC-OK was admitted.
    const okEvent = tick.filterEvents.find((e) => e.taskId === 'AISDLC-OK');
    expect(okEvent).toBeDefined();
    expect(okEvent!.trace.passed).toBe(true);
    expect(okEvent!.blockedEvent).toBeNull();

    // AISDLC-SOAK was rejected by the Dispatchability filter.
    const soakEvent = tick.filterEvents.find((e) => e.taskId === 'AISDLC-SOAK');
    expect(soakEvent).toBeDefined();
    expect(soakEvent!.trace.passed).toBe(false);
    expect(soakEvent!.blockedEvent).not.toBeNull();

    const blockedEvent = soakEvent!.blockedEvent as OrchestratorBlockedByDispatchabilityEvent;
    expect(blockedEvent.type).toBe('OrchestratorBlockedByDispatchability');
    expect(blockedEvent.taskId).toBe('AISDLC-SOAK');
    expect(blockedEvent.dispatchableReason).toBe('Operator soak phase — no code work');

    // The trace for the soak task should include the Dispatchability filter entry.
    const dispatchabilityTrace = soakEvent!.trace.trace.find((t) => t.filter === 'Dispatchability');
    expect(dispatchabilityTrace).toBeDefined();
    expect(dispatchabilityTrace!.passed).toBe(false);
    expect(dispatchabilityTrace!.reason).toBe('Operator soak phase — no code work');
  });

  it('non-dispatchable task with absent dispatchableReason uses default reason', async () => {
    const graph = buildGraph([node('AISDLC-ND')]);

    const dispatched: string[] = [];
    const config = defaultOrchestratorConfig({
      workDir: '/tmp/dispatchability-test-2',
      maxConcurrent: 1,
      maxTicks: 1,
      tickIntervalSec: 0,
    });

    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [{ id: 'AISDLC-ND', title: 'No reason provided' }],
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      taskDispatchableLoader: () => ({
        dispatchable: false,
        dispatchableReason: undefined, // no reason provided
      }),
      dispatch: async (taskId) => {
        dispatched.push(taskId);
        return approvedResult(taskId);
      },
      escalate: async () => {},
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };

    const tick = await runOrchestratorTick(config, adapters, 1);

    expect(dispatched).toEqual([]);
    expect(tick.filterEvents).toHaveLength(1);

    const ndEvent = tick.filterEvents[0];
    expect(ndEvent.blockedEvent?.type).toBe('OrchestratorBlockedByDispatchability');
    const ev = ndEvent.blockedEvent as OrchestratorBlockedByDispatchabilityEvent;
    expect(ev.dispatchableReason).toBe('marked dispatchable:false in frontmatter');
  });

  it('absent dispatchable field (undefined) is treated as dispatchable:true', async () => {
    const graph = buildGraph([node('AISDLC-IMPLICIT')]);

    const dispatched: string[] = [];
    const config = defaultOrchestratorConfig({
      workDir: '/tmp/dispatchability-test-3',
      maxConcurrent: 1,
      maxTicks: 1,
      tickIntervalSec: 0,
    });

    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [{ id: 'AISDLC-IMPLICIT', title: 'No dispatchable field' }],
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      // Simulates a pre-243 task file with no dispatchable field.
      taskDispatchableLoader: () => ({ dispatchable: undefined, dispatchableReason: undefined }),
      dispatch: async (taskId) => {
        dispatched.push(taskId);
        return approvedResult(taskId);
      },
      escalate: async () => {},
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };

    const tick = await runOrchestratorTick(config, adapters, 1);

    // Task is admitted (dispatchable by default).
    expect(dispatched).toEqual(['AISDLC-IMPLICIT']);
    expect(tick.filterEvents).toHaveLength(1);
    expect(tick.filterEvents[0].trace.passed).toBe(true);
    expect(tick.filterEvents[0].blockedEvent).toBeNull();
  });
});
