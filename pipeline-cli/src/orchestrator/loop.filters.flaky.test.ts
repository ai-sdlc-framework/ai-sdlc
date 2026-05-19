/*
 * Flaky variant: Phase 3 4-task fixture acceptance test for the orchestrator loop.
 *
 * Extracted from loop.filters.test.ts because runOrchestratorTick with a real
 * DoR calibration log times out 6s on CI under heavy CPU load (observed 2+x,
 * AISDLC-368). This file is excluded from the default vitest run via the
 * "**\/*.flaky.test.ts" exclude pattern in vitest.config.ts and is instead
 * exercised by the nightly .github/workflows/flaky-tests.yml workflow.
 *
 * First flaked: 2026-05-09 (AISDLC-368 emergency hotfix)
 * Convention: docs/operations/flaky-tests.md
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultOrchestratorConfig,
  ORCHESTRATOR_FLAG,
  runOrchestratorTick,
  type OrchestratorAdapters,
  type OrchestratorAwaitingExternalEvent,
  type OrchestratorBlockedByDependencyEvent,
  type OrchestratorBlockedByDorEvent,
} from './index.js';
import type {
  DependencyGraph,
  DependencyNode,
  ExternalDependency,
} from '../deps/dependency-graph.js';
import type { PipelineLogger, PipelineResult } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────

function silentLogger(): PipelineLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, progress: () => {} };
}

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

let tmp: string;
let logPath: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'phase3-loop-flaky-'));
  logPath = join(tmp, 'calibration.jsonl');
  process.env[ORCHESTRATOR_FLAG] = 'experimental';
});
afterEach(() => {
  delete process.env[ORCHESTRATOR_FLAG];
});

// ── Acceptance fixture (Phase 3 §11) ──────────────────────────────────

describe('runOrchestratorTick — Phase 3 4-task fixture acceptance [FLAKY]', () => {
  it('dispatches only the ready task; emits the matching block events for the other three', async () => {
    // Layout:
    //   AISDLC-DEP   — depends on AISDLC-OPEN (still open) → Dependency block
    //   AISDLC-DOR   — has a needs-clarification verdict in the log → DoR block
    //   AISDLC-EXT   — declares a `manual` external dep with no clearance → External block
    //   AISDLC-OK    — clean → admitted
    writeFileSync(
      logPath,
      JSON.stringify({
        ts: '2026-05-02T12:00:00Z',
        issueId: 'AISDLC-DOR',
        rubricVersion: 'v1',
        evaluatorVersion: 't',
        overallVerdict: 'needs-clarification',
        failedGates: [4],
        outcome: '',
        verdict: {
          issueId: 'AISDLC-DOR',
          rubricVersion: 'v1',
          overallVerdict: 'needs-clarification',
          gates: [],
          signedAt: '2026-05-02T12:00:00Z',
          evaluatorVersion: 't',
        },
      }) + '\n',
    );

    const graph = buildGraph([
      node('AISDLC-OPEN'),
      node('AISDLC-DEP', { deps: ['AISDLC-OPEN'] }),
      node('AISDLC-DOR'),
      node('AISDLC-EXT', {
        ext: [{ id: 'sec-review', description: 'wait', kind: 'manual' }],
      }),
      node('AISDLC-OK'),
    ]);

    const dispatched: string[] = [];
    const config = defaultOrchestratorConfig({
      workDir: tmp,
      // maxConcurrent = 4 so the chain considers EVERY candidate (the ready
      // task lands last in alphabetical order from the synthetic frontier).
      maxConcurrent: 4,
      maxTicks: 1,
      tickIntervalSec: 0,
    });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      // We pass the candidates excluding AISDLC-OPEN (which is a dependency
      // not itself a frontier candidate). Order matches the §4.3 §11 spec.
      frontier: () =>
        ['AISDLC-DEP', 'AISDLC-DOR', 'AISDLC-EXT', 'AISDLC-OK'].map((id) => ({
          id,
          title: id,
        })),
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      calibrationLogPath: logPath,
      dispatch: async (taskId) => {
        dispatched.push(taskId);
        return approvedResult(taskId);
      },
      escalate: async () => {},
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };
    const tick = await runOrchestratorTick(config, adapters, 1);

    expect(dispatched).toEqual(['AISDLC-OK']);
    expect(tick.dispatched).toEqual(['AISDLC-OK']);
    expect(tick.candidates).toBe(4);
    // Filter events: 4 records (one per evaluated candidate). Three carry a
    // blockedEvent; one (the OK one) does not.
    expect(tick.filterEvents).toHaveLength(4);
    const blockedById = new Map(
      tick.filterEvents
        .filter((e) => e.blockedEvent !== null)
        .map((e) => [e.taskId, e.blockedEvent!]),
    );
    expect([...blockedById.keys()].sort()).toEqual(['AISDLC-DEP', 'AISDLC-DOR', 'AISDLC-EXT']);

    const dep = blockedById.get('AISDLC-DEP') as OrchestratorBlockedByDependencyEvent;
    expect(dep.type).toBe('OrchestratorBlockedByDependency');
    expect(dep.blockers).toEqual(['aisdlc-open']);

    const dor = blockedById.get('AISDLC-DOR') as OrchestratorBlockedByDorEvent;
    expect(dor.type).toBe('OrchestratorBlockedByDor');
    expect(dor.verdict).toBe('needs-clarification');

    const ext = blockedById.get('AISDLC-EXT') as OrchestratorAwaitingExternalEvent;
    expect(ext.type).toBe('OrchestratorAwaitingExternal');
    expect(ext.externalDeps).toEqual([{ id: 'sec-review', kind: 'manual' }]);
    expect(ext.allExternalDeps).toEqual([{ id: 'sec-review', kind: 'manual' }]);

    // The fourth filter event (OK) is admitted.
    const ok = tick.filterEvents.find((e) => e.taskId === 'AISDLC-OK');
    expect(ok?.trace.passed).toBe(true);
    expect(ok?.blockedEvent).toBeNull();
  });
});
