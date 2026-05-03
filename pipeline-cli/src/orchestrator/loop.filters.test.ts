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
  opts: { deps?: string[]; ext?: ExternalDependency[]; status?: 'open' | 'completed' } = {},
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
  it('emits OrchestratorStuckCandidate exactly once after >5 ticks of the same skip', async () => {
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
  });

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
    });
    // 3 ticks → 2 inter-tick sleeps (no sleep after the last tick because
    // the loop breaks on maxTicks before sleeping).
    expect(sleepCalls).toHaveLength(2);
    expect(sleepCalls[0]).toBe(60_000);
    expect(sleepCalls[1]).toBe(120_000);
  });
});
