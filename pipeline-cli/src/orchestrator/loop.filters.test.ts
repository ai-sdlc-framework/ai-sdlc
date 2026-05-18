/**
 * Pre-dispatch filter integration tests for the orchestrator loop
 * (RFC-0015 Phase 3 / AISDLC-169.3).
 *
 * The Phase 3 task spec calls out a 4-task fixture queue:
 *   - 1 DoR-blocked task
 *   - 1 dependency-blocked task
 *   - 1 external-blocked task
 *   - 1 ready task
 *
 * Acceptance: the orchestrator dispatches ONLY the ready task and the
 * tick result carries the matching `OrchestratorBlockedBy*` /
 * `OrchestratorAwaitingExternal` events for the others.
 *
 * Other coverage in this file:
 *   - Stuck-candidate counter emits exactly once per streak (>5 ticks).
 *   - Backoff curve doubles per consecutive idle tick + caps at 5min.
 *   - Backoff resets on dispatch.
 *   - Backoff resets when a NEW task lands in the frontier.
 *   - Idle event types distinguish "no work" from "all filtered".
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultOrchestratorConfig,
  makeInitialCadenceState,
  MAX_IDLE_SLEEP_SEC,
  ORCHESTRATOR_FLAG,
  runOrchestratorLoop,
  runOrchestratorTick,
  STUCK_CANDIDATE_THRESHOLD,
  type CadenceState,
  type OrchestratorAdapters,
  type OrchestratorAwaitingExternalEvent,
  type OrchestratorBlockedByDependencyEvent,
  type OrchestratorBlockedByDorEvent,
  type OrchestratorOrphanParentEvent,
  type StuckCounterEntry,
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

function captureLogger(): { logger: PipelineLogger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (m) => lines.push(`info:${m}`),
      warn: () => {},
      error: () => {},
      progress: (s, st) => lines.push(`progress:${s}:${st}`),
    },
  };
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
  tmp = mkdtempSync(join(tmpdir(), 'phase3-loop-'));
  logPath = join(tmp, 'calibration.jsonl');
  process.env[ORCHESTRATOR_FLAG] = 'experimental';
});
afterEach(() => {
  delete process.env[ORCHESTRATOR_FLAG];
});

// ── Acceptance fixture (Phase 3 §11) ──────────────────────────────────

describe('runOrchestratorTick — Phase 3 4-task fixture acceptance', () => {
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

  it('logs a filter-trace block per evaluated candidate', async () => {
    const graph = buildGraph([node('AISDLC-OPEN'), node('AISDLC-DEP', { deps: ['AISDLC-OPEN'] })]);
    const cap = captureLogger();
    const config = defaultOrchestratorConfig({
      workDir: tmp,
      maxConcurrent: 1,
      maxTicks: 1,
      tickIntervalSec: 0,
    });
    await runOrchestratorTick(
      config,
      {
        logger: cap.logger,
        sleep: () => Promise.resolve(),
        frontier: () => [{ id: 'AISDLC-DEP', title: 'DEP' }],
        graphLoader: () => graph,
        taskLabelsLoader: () => [],
        dispatch: async (id) => approvedResult(id),
        escalate: async () => {},
        // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
        parentBranchGuard: async () => {},
      },
      1,
    );
    const traceLines = cap.lines.filter((l) =>
      l.includes('[orchestrator] filter trace for AISDLC-DEP'),
    );
    expect(traceLines).toHaveLength(1);
    // Trace block ends with the skip footer.
    const fullTrace = traceLines[0];
    expect(fullTrace).toContain('Dependency check: failed');
    expect(fullTrace).toContain('→ skipped, awaiting dependency');
  });
});

// ── Stuck-candidate detection (AC #4) ──────────────────────────────────

describe('runOrchestratorTick — stuck-candidate counter', () => {
  it(
    'emits OrchestratorStuckCandidate exactly once after >5 ticks of the same skip',
    { timeout: 15000 },
    async () => {
      const graph = buildGraph([
        node('AISDLC-OPEN'),
        node('AISDLC-STUCK', { deps: ['AISDLC-OPEN'] }),
      ]);
      const stuckCounters = new Map<string, StuckCounterEntry>();
      const config = defaultOrchestratorConfig({
        workDir: tmp,
        maxConcurrent: 1,
        maxTicks: 1,
        tickIntervalSec: 0,
      });
      const adapters: OrchestratorAdapters = {
        logger: silentLogger(),
        sleep: () => Promise.resolve(),
        frontier: () => [{ id: 'AISDLC-STUCK', title: 'STUCK' }],
        graphLoader: () => graph,
        taskLabelsLoader: () => [],
        dispatch: async (id) => approvedResult(id),
        escalate: async () => {},
        stuckCounters,
        // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
        parentBranchGuard: async () => {},
      };
      let stuckEmissions = 0;
      // Run THRESHOLD+2 consecutive ticks. The first THRESHOLD don't emit; the
      // (THRESHOLD+1)-th emits exactly once; subsequent ticks do not re-emit.
      for (let i = 0; i < STUCK_CANDIDATE_THRESHOLD + 2; i++) {
        const tick = await runOrchestratorTick(config, adapters, i + 1);
        const ev = tick.filterEvents.find((e) => e.taskId === 'AISDLC-STUCK');
        if (ev?.stuckEvent) stuckEmissions += 1;
      }
      expect(stuckEmissions).toBe(1);
      expect(stuckCounters.get('aisdlc-stuck')?.ticks).toBe(STUCK_CANDIDATE_THRESHOLD + 2);
    },
  );

  it('resets the stuck counter when the candidate is admitted', async () => {
    const graph1 = buildGraph([
      node('AISDLC-OPEN'),
      node('AISDLC-STUCK', { deps: ['AISDLC-OPEN'] }),
    ]);
    const graph2 = buildGraph([node('AISDLC-OPEN', undefined), node('AISDLC-STUCK')]);
    graph2.nodes.set('aisdlc-open', { ...graph2.nodes.get('aisdlc-open')!, status: 'completed' });
    const stuckCounters = new Map<string, StuckCounterEntry>();
    const config = defaultOrchestratorConfig({
      workDir: tmp,
      maxConcurrent: 1,
      maxTicks: 1,
      tickIntervalSec: 0,
    });

    // Tick 1 — STUCK is blocked.
    await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        sleep: () => Promise.resolve(),
        frontier: () => [{ id: 'AISDLC-STUCK', title: 'STUCK' }],
        graphLoader: () => graph1,
        taskLabelsLoader: () => [],
        dispatch: async (id) => approvedResult(id),
        escalate: async () => {},
        stuckCounters,
        // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
        parentBranchGuard: async () => {},
      },
      1,
    );
    expect(stuckCounters.get('aisdlc-stuck')?.ticks).toBe(1);

    // Tick 2 — STUCK admitted (graph2 marks AISDLC-OPEN as completed).
    await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        sleep: () => Promise.resolve(),
        frontier: () => [{ id: 'AISDLC-STUCK', title: 'STUCK' }],
        graphLoader: () => graph2,
        taskLabelsLoader: () => [],
        dispatch: async (id) => approvedResult(id),
        escalate: async () => {},
        stuckCounters,
        // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
        parentBranchGuard: async () => {},
      },
      2,
    );
    expect(stuckCounters.has('aisdlc-stuck')).toBe(false);
  });
});

// ── Backoff cadence (AC #5) ────────────────────────────────────────────

describe('runOrchestratorTick — exponential backoff cadence', () => {
  it('doubles the interval on each consecutive idle tick + caps at 5min', async () => {
    const cadence: CadenceState = makeInitialCadenceState(30);
    const config = defaultOrchestratorConfig({
      workDir: tmp,
      maxConcurrent: 1,
      maxTicks: 1,
      tickIntervalSec: 30,
    });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [],
      graphLoader: () => buildGraph([]),
      taskLabelsLoader: () => [],
      dispatch: async (id) => approvedResult(id),
      escalate: async () => {},
      cadenceState: cadence,
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };
    // Drive enough idle ticks to saturate the cap. 30 → 60 → 120 → 240 → 300 (cap)
    const intervals: number[] = [];
    for (let i = 0; i < 8; i++) {
      const tick = await runOrchestratorTick(config, adapters, i + 1);
      intervals.push(tick.nextSleepSec);
    }
    expect(intervals[0]).toBe(60);
    expect(intervals[1]).toBe(120);
    expect(intervals[2]).toBe(240);
    expect(intervals[3]).toBe(MAX_IDLE_SLEEP_SEC); // 300, capped
    for (let i = 4; i < intervals.length; i++) {
      expect(intervals[i]).toBe(MAX_IDLE_SLEEP_SEC);
    }
  });

  it('resets the backoff to the base interval on dispatch', async () => {
    const cadence: CadenceState = makeInitialCadenceState(30);
    cadence.currentIntervalSec = 240;
    cadence.idleStreak = 4;
    const config = defaultOrchestratorConfig({
      workDir: tmp,
      maxConcurrent: 1,
      maxTicks: 1,
      tickIntervalSec: 30,
    });
    const tick = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        sleep: () => Promise.resolve(),
        frontier: () => [{ id: 'AISDLC-OK', title: 'OK' }],
        graphLoader: () => buildGraph([node('AISDLC-OK')]),
        taskLabelsLoader: () => [],
        dispatch: async (id) => approvedResult(id),
        escalate: async () => {},
        cadenceState: cadence,
        // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
        parentBranchGuard: async () => {},
      },
      1,
    );
    expect(tick.nextSleepSec).toBe(30);
    expect(cadence.idleStreak).toBe(0);
  });

  it('resets the backoff when a NEW task lands in the frontier', async () => {
    // Pre-populate cadence with a saturated streak + remember just AISDLC-A.
    const cadence: CadenceState = makeInitialCadenceState(30);
    cadence.currentIntervalSec = MAX_IDLE_SLEEP_SEC;
    cadence.idleStreak = 10;
    cadence.lastFrontierIds = new Set(['AISDLC-A']);
    // This tick the frontier has AISDLC-A AND a new AISDLC-B that gets
    // filtered out — even though we still skip-end-up-idle, the wake
    // condition fires and resets the curve before the idle increment.
    const graph = buildGraph([
      node('AISDLC-A', { ext: [{ id: 'manual1', description: 'wait', kind: 'manual' }] }),
      node('AISDLC-B', { ext: [{ id: 'manual2', description: 'wait', kind: 'manual' }] }),
    ]);
    const config = defaultOrchestratorConfig({
      workDir: tmp,
      maxConcurrent: 1,
      maxTicks: 1,
      tickIntervalSec: 30,
    });
    const tick = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        sleep: () => Promise.resolve(),
        frontier: () => [
          { id: 'AISDLC-A', title: 'A' },
          { id: 'AISDLC-B', title: 'B' },
        ],
        graphLoader: () => graph,
        taskLabelsLoader: () => [],
        dispatch: async (id) => approvedResult(id),
        escalate: async () => {},
        cadenceState: cadence,
        // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
        parentBranchGuard: async () => {},
      },
      1,
    );
    // Reset to base (30s), then idle-increment to 60s for THIS tick's idle.
    expect(tick.nextSleepSec).toBe(60);
    expect(cadence.idleStreak).toBe(1);
  });

  it('emits OrchestratorIdleNoWork when frontier is empty', async () => {
    const tick = await runOrchestratorTick(
      defaultOrchestratorConfig({
        workDir: tmp,
        maxTicks: 1,
        tickIntervalSec: 30,
      }),
      {
        logger: silentLogger(),
        sleep: () => Promise.resolve(),
        frontier: () => [],
        graphLoader: () => buildGraph([]),
        taskLabelsLoader: () => [],
        dispatch: async (id) => approvedResult(id),
        escalate: async () => {},
        // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
        parentBranchGuard: async () => {},
      },
      1,
    );
    expect(tick.idleEvent?.type).toBe('OrchestratorIdleNoWork');
  });

  it('emits OrchestratorIdleAllFiltered when every candidate was filtered out', async () => {
    const graph = buildGraph([node('AISDLC-OPEN'), node('AISDLC-A', { deps: ['AISDLC-OPEN'] })]);
    const tick = await runOrchestratorTick(
      defaultOrchestratorConfig({
        workDir: tmp,
        maxConcurrent: 1,
        maxTicks: 1,
        tickIntervalSec: 30,
      }),
      {
        logger: silentLogger(),
        sleep: () => Promise.resolve(),
        frontier: () => [{ id: 'AISDLC-A', title: 'A' }],
        graphLoader: () => graph,
        taskLabelsLoader: () => [],
        dispatch: async (id) => approvedResult(id),
        escalate: async () => {},
        // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
        parentBranchGuard: async () => {},
      },
      1,
    );
    expect(tick.idleEvent?.type).toBe('OrchestratorIdleAllFiltered');
    if (tick.idleEvent?.type === 'OrchestratorIdleAllFiltered') {
      expect(tick.idleEvent.rejectedCount).toBe(1);
    }
  });
});

// ── runOrchestratorLoop — backoff sleep cadence ───────────────────────

describe('runOrchestratorLoop — uses tick.nextSleepSec for inter-tick sleep', () => {
  it('honors the backoff curve, NOT the static config.tickIntervalSec', async () => {
    const sleepCalls: number[] = [];
    const cadence: CadenceState = makeInitialCadenceState(30);
    const config = defaultOrchestratorConfig({
      workDir: tmp,
      maxConcurrent: 1,
      maxTicks: 3,
      tickIntervalSec: 30,
    });
    await runOrchestratorLoop(config, {
      logger: silentLogger(),
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
      },
      frontier: () => [],
      graphLoader: () => buildGraph([]),
      taskLabelsLoader: () => [],
      dispatch: async (id) => approvedResult(id),
      escalate: async () => {},
      cadenceState: cadence,
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    });
    // 3 ticks → 2 inter-tick sleeps (no sleep after the last tick because
    // the loop breaks on maxTicks before sleeping).
    expect(sleepCalls).toHaveLength(2);
    expect(sleepCalls[0]).toBe(60_000);
    expect(sleepCalls[1]).toBe(120_000);
  });
});

// ── AISDLC-175 witness regression ─────────────────────────────────────

describe('runOrchestratorTick — AISDLC-175 orphan-parent witness regression', () => {
  it('skips the orphan parent + dispatches the real bug task instead', async () => {
    // Witness reproduction: 2026-05-04 dogfood run picked up AISDLC-70
    // (RFC-0010 parent task with all 9 sub-tasks already in
    // backlog/completed/) ahead of real work. The fix should make the
    // orchestrator skip the orphan parent and pick the real bug task.
    //
    // Fixture:
    //   AISDLC-PARENT — parent of two completed children → ORPHAN, skip.
    //   AISDLC-PARENT.1, .2 — completed children of AISDLC-PARENT.
    //   AISDLC-BUG    — real open bug task → ADMIT + dispatch.
    const graph = buildGraph([
      node('AISDLC-PARENT'),
      node('AISDLC-PARENT.1', { status: 'completed', parent: 'AISDLC-PARENT' }),
      node('AISDLC-PARENT.2', { status: 'completed', parent: 'AISDLC-PARENT' }),
      node('AISDLC-BUG'),
    ]);

    const dispatched: string[] = [];
    const config = defaultOrchestratorConfig({
      workDir: tmp,
      // maxConcurrent = 2 so the chain considers BOTH the orphan parent
      // and the real bug task — verifying the orphan is filtered out
      // (not just deprioritised) and the bug still gets through.
      maxConcurrent: 2,
      maxTicks: 1,
      tickIntervalSec: 0,
    });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      // Orphan parent ranked FIRST in the frontier (matches the witness
      // — AISDLC-70 was picked because it sorts before later IDs). The
      // filter must reject it even though it tops the queue.
      frontier: () => [
        { id: 'AISDLC-PARENT', title: 'PARENT' },
        { id: 'AISDLC-BUG', title: 'BUG' },
      ],
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      dispatch: async (taskId) => {
        dispatched.push(taskId);
        return approvedResult(taskId);
      },
      escalate: async () => {},
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };
    const tick = await runOrchestratorTick(config, adapters, 1);

    // Bug task dispatched, orphan parent skipped.
    expect(dispatched).toEqual(['AISDLC-BUG']);
    expect(tick.dispatched).toEqual(['AISDLC-BUG']);

    // Orphan parent surfaces as a structured filter rejection so
    // operators see it in the events.jsonl bus + cli-status view.
    const orphanEvt = tick.filterEvents.find((e) => e.taskId === 'AISDLC-PARENT');
    expect(orphanEvt?.trace.passed).toBe(false);
    expect(orphanEvt?.trace.failure?.filter).toBe('OrphanParent');
    const orphanBlocked = orphanEvt?.blockedEvent as OrchestratorOrphanParentEvent;
    expect(orphanBlocked.type).toBe('OrchestratorOrphanParent');
    expect(orphanBlocked.completedChildren).toEqual(['aisdlc-parent.1', 'aisdlc-parent.2']);

    // Bug task admitted (no blockedEvent + chain.passed === true).
    const bugEvt = tick.filterEvents.find((e) => e.taskId === 'AISDLC-BUG');
    expect(bugEvt?.trace.passed).toBe(true);
    expect(bugEvt?.blockedEvent).toBeNull();
  });

  it('emits OrchestratorOrphanParent on the events.jsonl bus when the filter rejects', async () => {
    // Verify the loop forwards the orphan-parent rejection to the events
    // sink (the same path the date-rotated events.jsonl writer uses). A
    // capturing sink keeps the test hermetic.
    const graph = buildGraph([
      node('AISDLC-ORPHAN'),
      node('AISDLC-ORPHAN.1', { status: 'completed', parent: 'AISDLC-ORPHAN' }),
    ]);
    const captured: Array<{ type: string; taskId?: string; completedChildren?: string[] }> = [];
    const config = defaultOrchestratorConfig({
      workDir: tmp,
      maxConcurrent: 1,
      maxTicks: 1,
      tickIntervalSec: 0,
    });
    await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        sleep: () => Promise.resolve(),
        frontier: () => [{ id: 'AISDLC-ORPHAN', title: 'ORPHAN' }],
        graphLoader: () => graph,
        taskLabelsLoader: () => [],
        dispatch: async (id) => approvedResult(id),
        escalate: async () => {},
        emitEvent: (event) => {
          captured.push(event as { type: string; taskId?: string; completedChildren?: string[] });
        },
        // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
        parentBranchGuard: async () => {},
      },
      1,
    );
    const orphanEvent = captured.find((e) => e.type === 'OrchestratorOrphanParent');
    expect(orphanEvent).toBeDefined();
    expect(orphanEvent?.taskId).toBe('AISDLC-ORPHAN');
    expect(orphanEvent?.completedChildren).toEqual(['aisdlc-orphan.1']);
  });
});

// ── AISDLC-223 witness regression — operator-blocked filter ───────────

describe('runOrchestratorTick — AISDLC-223 operator-blocked filter (AC #6 + AC #7)', () => {
  it('dispatches only the ready task; skips the blocked task; events.jsonl gets a TaskBlocked entry', async () => {
    // AC #7: tick fixture with one blocked + one ready task →
    //   - only the ready task is dispatched
    //   - events.jsonl contains a TaskBlocked entry for the blocked one
    const graph = buildGraph([node('AISDLC-BLOCKED'), node('AISDLC-READY')]);

    const dispatched: string[] = [];
    const captured: Array<{ type: string; taskId?: string; reason?: string }> = [];
    const config = defaultOrchestratorConfig({
      workDir: tmp,
      maxConcurrent: 2,
      maxTicks: 1,
      tickIntervalSec: 0,
    });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [
        { id: 'AISDLC-BLOCKED', title: 'BLOCKED' },
        { id: 'AISDLC-READY', title: 'READY' },
      ],
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      // AC #7: inject the blocked frontmatter for AISDLC-BLOCKED
      taskBlockedLoader: (taskId) => {
        if (taskId === 'AISDLC-BLOCKED') {
          return {
            reason: 'Soaking — promotion gated on AISDLC-116 evidence',
            until: '2026-05-13',
          };
        }
        return undefined;
      },
      dispatch: async (taskId) => {
        dispatched.push(taskId);
        return approvedResult(taskId);
      },
      escalate: async () => {},
      emitEvent: (event) => {
        captured.push(event as { type: string; taskId?: string; reason?: string });
      },
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };
    const tick = await runOrchestratorTick(config, adapters, 1);

    // AC #7a: only the ready task is dispatched.
    expect(dispatched).toEqual(['AISDLC-READY']);
    expect(tick.dispatched).toEqual(['AISDLC-READY']);

    // AC #7b: events.jsonl contains a TaskBlocked entry for the blocked one.
    const blockedEvent = captured.find((e) => e.type === 'TaskBlocked');
    expect(blockedEvent).toBeDefined();
    expect(blockedEvent?.taskId).toBe('AISDLC-BLOCKED');
    expect(blockedEvent?.reason).toBe('Soaking — promotion gated on AISDLC-116 evidence');

    // The blocked task surfaces as a structured filter rejection.
    const blockedFilterEvt = tick.filterEvents.find((e) => e.taskId === 'AISDLC-BLOCKED');
    expect(blockedFilterEvt?.trace.passed).toBe(false);
    expect(blockedFilterEvt?.trace.failure?.filter).toBe('Blocked');

    // The ready task is admitted.
    const readyEvt = tick.filterEvents.find((e) => e.taskId === 'AISDLC-READY');
    expect(readyEvt?.trace.passed).toBe(true);
    expect(readyEvt?.blockedEvent).toBeNull();
  });

  it('passes when no blocked field is present (backward-compatible)', async () => {
    // AC #6: task without blocked field → filter returns passed: true
    const graph = buildGraph([node('AISDLC-OK')]);
    const dispatched: string[] = [];
    const config = defaultOrchestratorConfig({
      workDir: tmp,
      maxConcurrent: 1,
      maxTicks: 1,
      tickIntervalSec: 0,
    });
    await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        sleep: () => Promise.resolve(),
        frontier: () => [{ id: 'AISDLC-OK', title: 'OK' }],
        graphLoader: () => graph,
        taskLabelsLoader: () => [],
        // No taskBlockedLoader → defaults to "not blocked".
        dispatch: async (taskId) => {
          dispatched.push(taskId);
          return approvedResult(taskId);
        },
        escalate: async () => {},
        // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
        parentBranchGuard: async () => {},
      },
      1,
    );
    expect(dispatched).toEqual(['AISDLC-OK']);
  });
});

// ── AISDLC-361 — OpenPullRequestExists filter (AC #1 + #3 + #4) ──────────────

describe('runOrchestratorTick — AISDLC-361 OpenPullRequestExists filter', () => {
  it('skips a task whose canonical branch has an open PR; dispatches a ready task; emits OrchestratorBlockedByOpenPullRequest event (AC #1, #3, #4)', async () => {
    // Scenario: two tasks on the frontier.
    //   AISDLC-STUCK — canonical branch `ai-sdlc/aisdlc-stuck-stuck-task`
    //     already has open PR #42 (as if a prior run opened it and the
    //     worktree was subsequently deleted but the PR was never merged).
    //   AISDLC-READY — no open PR → admitted.
    const graph = buildGraph([node('AISDLC-STUCK'), node('AISDLC-READY')]);

    const dispatched: string[] = [];
    const capturedEvents: Array<{ type: string; taskId?: string; prNumber?: number }> = [];
    const config = defaultOrchestratorConfig({
      workDir: tmp,
      maxConcurrent: 2,
      maxTicks: 1,
      tickIntervalSec: 0,
    });

    // Per-tick cache shared across filter evaluations (AC #2 — injected as
    // empty Map; the filter populates it on first access via listOpenPRsByBranch).
    const prListCache = new Map<
      string,
      import('./filters/open-pull-request-exists.js').OpenPREntry[]
    >();

    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [
        { id: 'AISDLC-STUCK', title: 'stuck task' },
        { id: 'AISDLC-READY', title: 'ready task' },
      ],
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      // Inject the open-PR stub: AISDLC-STUCK's branch has PR #42;
      // AISDLC-READY has no open PR.
      openPRExistsOpts: {
        listOpenPRsByBranch: (branch: string) => {
          if (branch === 'ai-sdlc/aisdlc-stuck-stuck-task') {
            return [
              {
                number: 42,
                isDraft: false,
                url: 'https://github.com/org/repo/pull/42',
              },
            ];
          }
          return [];
        },
        prListCache,
      },
      dispatch: async (taskId) => {
        dispatched.push(taskId);
        return approvedResult(taskId);
      },
      escalate: async () => {},
      emitEvent: (event) => {
        capturedEvents.push(event as { type: string; taskId?: string; prNumber?: number });
      },
    };

    const tick = await runOrchestratorTick(config, adapters, 1);

    // AC #1: AISDLC-STUCK is skipped; AISDLC-READY is dispatched.
    expect(dispatched).toEqual(['AISDLC-READY']);
    expect(tick.dispatched).toEqual(['AISDLC-READY']);

    // AC #3: filter trace surfaces the rejection for AISDLC-STUCK.
    const stuckEvt = tick.filterEvents.find((e) => e.taskId === 'AISDLC-STUCK');
    expect(stuckEvt?.trace.passed).toBe(false);
    expect(stuckEvt?.trace.failure?.filter).toBe('OpenPullRequestExists');
    expect(stuckEvt?.trace.failure?.detail).toMatchObject({
      kind: 'open-pull-request-exists',
      prNumber: 42,
      isDraft: false,
      branchName: 'ai-sdlc/aisdlc-stuck-stuck-task',
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    // AC #4: events.jsonl gets an OrchestratorBlockedByOpenPullRequest entry.
    const blockedEvent = capturedEvents.find(
      (e) => e.type === 'OrchestratorBlockedByOpenPullRequest',
    );
    expect(blockedEvent).toBeDefined();
    expect(blockedEvent?.taskId).toBe('AISDLC-STUCK');
    expect(blockedEvent?.prNumber).toBe(42);

    // AC #5 (filter trace UX): the formatted trace includes the PR URL.
    const readyEvt = tick.filterEvents.find((e) => e.taskId === 'AISDLC-READY');
    expect(readyEvt?.trace.passed).toBe(true);
  });

  it('admits a task when no open PR exists for its branch (AC #3 negative path)', async () => {
    const graph = buildGraph([node('AISDLC-CLEAN')]);
    const dispatched: string[] = [];
    const config = defaultOrchestratorConfig({
      workDir: tmp,
      maxConcurrent: 1,
      maxTicks: 1,
      tickIntervalSec: 0,
    });
    const tick = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        sleep: () => Promise.resolve(),
        frontier: () => [{ id: 'AISDLC-CLEAN', title: 'clean task' }],
        graphLoader: () => graph,
        taskLabelsLoader: () => [],
        openPRExistsOpts: { listOpenPRsByBranch: () => [] },
        dispatch: async (taskId) => {
          dispatched.push(taskId);
          return approvedResult(taskId);
        },
        escalate: async () => {},
      },
      1,
    );
    expect(dispatched).toEqual(['AISDLC-CLEAN']);
    const evt = tick.filterEvents.find((e) => e.taskId === 'AISDLC-CLEAN');
    expect(evt?.trace.passed).toBe(true);
  });

  it('uses the tick-scoped cache: gh stub called once per unique branch (AC #2)', async () => {
    const graph = buildGraph([node('AISDLC-A'), node('AISDLC-B')]);
    const dispatched: string[] = [];
    let callCount = 0;
    const prListCache = new Map<
      string,
      import('./filters/open-pull-request-exists.js').OpenPREntry[]
    >();
    const config = defaultOrchestratorConfig({
      workDir: tmp,
      maxConcurrent: 2,
      maxTicks: 1,
      tickIntervalSec: 0,
    });
    await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        sleep: () => Promise.resolve(),
        frontier: () => [
          { id: 'AISDLC-A', title: 'task a' },
          { id: 'AISDLC-B', title: 'task b' },
        ],
        graphLoader: () => graph,
        taskLabelsLoader: () => [],
        openPRExistsOpts: {
          listOpenPRsByBranch: () => {
            callCount += 1;
            return [];
          },
          prListCache,
        },
        dispatch: async (taskId) => {
          dispatched.push(taskId);
          return approvedResult(taskId);
        },
        escalate: async () => {},
      },
      1,
    );
    // Two distinct branches → two calls, not one (different task IDs → different branch names).
    // Cache means a second tick with the SAME candidates would not fire again.
    expect(callCount).toBe(2);
    expect(dispatched).toHaveLength(2);
    // Cache is populated: both branch names should be present.
    expect(prListCache.size).toBe(2);
  });
});
