/**
 * AISDLC-395 (RFC-0035 Phase 5) — hermetic integration tests for the
 * Decision Catalog auto-filing path wired into the DorReadiness admission
 * filter.
 *
 * AC coverage:
 *   AC-1: DorReadiness block → emitDorDecisions is called with the verdict.
 *   AC-2: Call is gated on AI_SDLC_DECISION_CATALOG flag (degrade-open).
 *   AC-3: Emitted decisions land in the decisions event log with the correct
 *         source + scope.
 *   AC-4: Second tick with the same DoR-blocked task → no duplicate Decision.
 *   AC-5: OrchestratorEmittedDecision event appears on the orchestrator event bus.
 *   AC-6 (flag-off): flag disabled → no Decision emitted, DorReadiness still blocks.
 *   AC-6 (flag-on):  flag on (default) → Decision emitted on first block tick.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultOrchestratorConfig,
  ORCHESTRATOR_FLAG,
  runOrchestratorTick,
  type OrchestratorAdapters,
} from './index.js';
import type { DependencyGraph, DependencyNode } from '../deps/dependency-graph.js';
import type { OrchestratorEvent } from './events.js';
import type { PipelineLogger, PipelineResult } from '../types.js';
import { listDecisions } from '../decisions/projection.js';
import { DECISION_CATALOG_FLAG } from '../decisions/feature-flag.js';

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
    lastModified: '2026-05-22T00:00:00Z',
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

/**
 * Write a minimal calibration JSONL entry so the DorReadiness filter
 * returns `needs-clarification` for the given task.
 */
function writeCalibrationEntry(logPath: string, taskId: string, questions: string[]): void {
  mkdirSync(join(logPath, '..'), { recursive: true });
  const entry = {
    ts: '2026-05-22T12:00:00Z',
    issueId: taskId,
    rubricVersion: 'v1',
    evaluatorVersion: 'test-v1',
    overallVerdict: 'needs-clarification',
    failedGates: [4],
    outcome: '',
    verdict: {
      issueId: taskId,
      rubricVersion: 'v1',
      overallVerdict: 'needs-clarification',
      gates: [],
      signedAt: '2026-05-22T12:00:00Z',
      evaluatorVersion: 'test-v1',
      questions,
    },
  };
  writeFileSync(logPath, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
}

// ── Test fixtures ─────────────────────────────────────────────────────

const TASK_ID = 'AISDLC-395-TEST';
const QUESTIONS = [
  'What does "faster" mean in the context of this feature?',
  'Which auth flow should be used for the API endpoint?',
];

let tmp: string;
let calibrationLogPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aisdlc-395-loop-'));
  calibrationLogPath = join(tmp, '_dor', 'calibration.jsonl');
  mkdirSync(join(tmp, '_dor'), { recursive: true });
  process.env[ORCHESTRATOR_FLAG] = 'experimental';
  // Decision Catalog on by default (AISDLC-392).
  process.env[DECISION_CATALOG_FLAG] = 'experimental';
});

afterEach(() => {
  delete process.env[ORCHESTRATOR_FLAG];
  delete process.env[DECISION_CATALOG_FLAG];
  rmSync(tmp, { recursive: true, force: true });
});

// ── AC-1 + AC-3: DorReadiness block → emitDorDecisions called, decisions filed ─

describe('AISDLC-395 — DorReadiness block auto-files Decisions (AC-1, AC-3)', () => {
  it('files one Decision per blocking question when DoR blocks a task', async () => {
    writeCalibrationEntry(calibrationLogPath, TASK_ID, QUESTIONS);
    const graph = buildGraph([node(TASK_ID)]);
    const config = defaultOrchestratorConfig({ workDir: tmp, maxConcurrent: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [{ id: TASK_ID, title: TASK_ID }],
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      dispatch: async (id) => approvedResult(id),
      escalate: async () => {},
      calibrationLogPath,
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 1);

    const { decisions } = listDecisions({ workDir: tmp });
    expect(decisions).toHaveLength(QUESTIONS.length);

    for (const d of decisions) {
      expect(d.metadata.source).toBe('dor-clarification');
      expect(d.metadata.scope).toBe(`issue:${TASK_ID}`);
      expect(d.status.lifecycle).toBe('open');
    }

    const summaries = decisions.map((d) => d.spec.summary);
    expect(summaries).toContain(QUESTIONS[0]);
    expect(summaries).toContain(QUESTIONS[1]);
  });
});

// ── AC-4: Second tick with same DoR-blocked task → no duplicate Decisions ──────

describe('AISDLC-395 — Idempotency: second tick does NOT re-file (AC-4)', () => {
  it('does not create duplicate Decisions when the same DoR-blocked task recurs', async () => {
    writeCalibrationEntry(calibrationLogPath, TASK_ID, QUESTIONS);
    const graph = buildGraph([node(TASK_ID)]);
    const config = defaultOrchestratorConfig({ workDir: tmp, maxConcurrent: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [{ id: TASK_ID, title: TASK_ID }],
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      dispatch: async (id) => approvedResult(id),
      escalate: async () => {},
      calibrationLogPath,
      parentBranchGuard: async () => {},
    };

    // Tick 1 — files the decisions.
    await runOrchestratorTick(config, adapters, 1);
    const { decisions: after1 } = listDecisions({ workDir: tmp });
    expect(after1).toHaveLength(QUESTIONS.length);

    // Tick 2 — same task is still DoR-blocked; no new decisions should appear.
    await runOrchestratorTick(config, adapters, 2);
    const { decisions: after2 } = listDecisions({ workDir: tmp });
    expect(after2).toHaveLength(QUESTIONS.length);
  });
});

// ── AC-5: OrchestratorEmittedDecision event appears on the event bus ───────────

describe('AISDLC-395 — OrchestratorEmittedDecision event emitted (AC-5)', () => {
  it('emits OrchestratorEmittedDecision with decisionIds + emitted count + scope', async () => {
    writeCalibrationEntry(calibrationLogPath, TASK_ID, QUESTIONS);
    const graph = buildGraph([node(TASK_ID)]);
    const config = defaultOrchestratorConfig({ workDir: tmp, maxConcurrent: 1 });
    const captured: OrchestratorEvent[] = [];
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [{ id: TASK_ID, title: TASK_ID }],
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      dispatch: async (id) => approvedResult(id),
      escalate: async () => {},
      calibrationLogPath,
      emitEvent: (ev) => captured.push(ev),
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 1);

    const emittedDecisionEvents = captured.filter((e) => e.type === 'OrchestratorEmittedDecision');
    expect(emittedDecisionEvents).toHaveLength(1);

    const ev = emittedDecisionEvents[0]!;
    expect(ev.taskId).toBe(TASK_ID);
    expect(ev.emitted).toBe(QUESTIONS.length);
    expect((ev.decisionIds as string[]).length).toBe(QUESTIONS.length);
    expect(ev.scope).toBe(`issue:${TASK_ID}`);
    expect(ev.skippedDuplicates).toBe(0);
  });

  it('does NOT emit OrchestratorEmittedDecision on the second tick (all duplicates)', async () => {
    writeCalibrationEntry(calibrationLogPath, TASK_ID, QUESTIONS);
    const graph = buildGraph([node(TASK_ID)]);
    const config = defaultOrchestratorConfig({ workDir: tmp, maxConcurrent: 1 });
    const capturedTick2: OrchestratorEvent[] = [];

    const sharedAdapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [{ id: TASK_ID, title: TASK_ID }],
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      dispatch: async (id) => approvedResult(id),
      escalate: async () => {},
      calibrationLogPath,
      parentBranchGuard: async () => {},
    };

    // Tick 1 — files decisions.
    await runOrchestratorTick(config, sharedAdapters, 1);

    // Tick 2 — all questions already have open decisions → no new emit event.
    await runOrchestratorTick(
      config,
      { ...sharedAdapters, emitEvent: (ev) => capturedTick2.push(ev) },
      2,
    );

    const emittedDecisionEvents = capturedTick2.filter(
      (e) => e.type === 'OrchestratorEmittedDecision',
    );
    expect(emittedDecisionEvents).toHaveLength(0);
  });
});

// ── AC-2 + AC-6: flag-off → no Decisions, but DorReadiness still blocks ───────

describe('AISDLC-395 — Feature flag off: no Decision filed, DoR still blocks (AC-2, AC-6)', () => {
  it('does not file Decisions when AI_SDLC_DECISION_CATALOG is off', async () => {
    // AISDLC-392 promoted the flag to default-on: empty string ('') is
    // treated as unset → ENABLED. Use an explicit falsy value ('off') to
    // actually disable the catalog for this test.
    process.env[DECISION_CATALOG_FLAG] = 'off';
    writeCalibrationEntry(calibrationLogPath, TASK_ID, QUESTIONS);
    const graph = buildGraph([node(TASK_ID)]);
    const config = defaultOrchestratorConfig({ workDir: tmp, maxConcurrent: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [{ id: TASK_ID, title: TASK_ID }],
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      dispatch: async (id) => approvedResult(id),
      escalate: async () => {},
      calibrationLogPath,
      parentBranchGuard: async () => {},
    };

    const tick = await runOrchestratorTick(config, adapters, 1);

    // DorReadiness still blocked the task.
    const dorEvent = tick.filterEvents.find(
      (e) => e.blockedEvent?.type === 'OrchestratorBlockedByDor',
    );
    expect(dorEvent).toBeDefined();

    // No Decisions filed.
    const { decisions } = listDecisions({ workDir: tmp });
    expect(decisions).toHaveLength(0);
  });

  it('does not emit OrchestratorEmittedDecision when flag is off', async () => {
    // AISDLC-392 promoted the flag to default-on: empty string ('') is
    // treated as unset → ENABLED. Use an explicit falsy value ('off') to
    // actually disable the catalog for this test.
    process.env[DECISION_CATALOG_FLAG] = 'off';
    writeCalibrationEntry(calibrationLogPath, TASK_ID, QUESTIONS);
    const graph = buildGraph([node(TASK_ID)]);
    const config = defaultOrchestratorConfig({ workDir: tmp, maxConcurrent: 1 });
    const captured: OrchestratorEvent[] = [];
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [{ id: TASK_ID, title: TASK_ID }],
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      dispatch: async (id) => approvedResult(id),
      escalate: async () => {},
      calibrationLogPath,
      emitEvent: (ev) => captured.push(ev),
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 1);

    const emittedEvents = captured.filter((e) => e.type === 'OrchestratorEmittedDecision');
    expect(emittedEvents).toHaveLength(0);
  });
});

// ── AC-6 (flag-on default): Decision emitted on first block tick ───────────────

describe('AISDLC-395 — Flag on (default): Decision emitted on first block tick (AC-6)', () => {
  it('emits Decision when AI_SDLC_DECISION_CATALOG=experimental (the default)', async () => {
    // Flag is set to 'experimental' in beforeEach — no override needed.
    writeCalibrationEntry(calibrationLogPath, TASK_ID, ['Which auth flow?']);
    const graph = buildGraph([node(TASK_ID)]);
    const config = defaultOrchestratorConfig({ workDir: tmp, maxConcurrent: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => [{ id: TASK_ID, title: TASK_ID }],
      graphLoader: () => graph,
      taskLabelsLoader: () => [],
      dispatch: async (id) => approvedResult(id),
      escalate: async () => {},
      calibrationLogPath,
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 1);

    const { decisions } = listDecisions({ workDir: tmp });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.spec.summary).toBe('Which auth flow?');
    expect(decisions[0]!.metadata.source).toBe('dor-clarification');
  });
});
