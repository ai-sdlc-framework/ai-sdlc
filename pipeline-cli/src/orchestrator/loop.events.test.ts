/**
 * Integration tests for the loop's events.jsonl wiring
 * (RFC-0015 Phase 4 / AISDLC-169.4).
 *
 * Asserts that one full tick lifecycle emits the expected event
 * sequence:
 *   1. happy path — Tick → Dispatched → Completed
 *   2. failure path — Tick → Dispatched → Failed (UnknownFailureMode)
 *   3. needs-human-attention — Tick → Dispatched → Completed → Failed
 *      (executePipeline returned NHA + the orchestrator additionally
 *      labels via the escalator + emits a synthetic Failed for the
 *      consumer surface)
 *   4. empty frontier — Tick only (no Dispatched/Completed)
 *
 * Uses the injected `emitEvent` adapter so we don't touch the
 * filesystem; the writer's own behavior is covered by `events.test.ts`.
 *
 * Also asserts that the emitter is a no-op for the event channel when
 * the injected sink throws — observability MUST NOT crash the loop.
 */

import { describe, expect, it } from 'vitest';

import {
  defaultOrchestratorConfig,
  runOrchestratorTick,
  type OrchestratorAdapters,
} from './index.js';
import type { OrchestratorEvent } from './events.js';
import type { PipelineLogger, PipelineResult } from '../types.js';

function silentLogger(): PipelineLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, progress: () => {} };
}

function fakeFrontier(ids: string[]): () => Array<{ id: string; title: string }> {
  return () => ids.map((id) => ({ id, title: `Task ${id}` }));
}

function approvedResult(taskId: string, prUrl: string | null = null): PipelineResult {
  return {
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktreePath: `.worktrees/${taskId.toLowerCase()}`,
    outcome: 'approved',
    prUrl,
    siblingPrUrls: [],
    iterations: 1,
    finalVerdict: null,
  };
}

function nhaResult(taskId: string, prUrl: string | null = null): PipelineResult {
  return {
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktreePath: `.worktrees/${taskId.toLowerCase()}`,
    outcome: 'needs-human-attention',
    prUrl,
    siblingPrUrls: [],
    iterations: 2,
    finalVerdict: null,
    notes: 'iteration cap exceeded',
  };
}

function captureSink(): { events: OrchestratorEvent[]; sink: (e: OrchestratorEvent) => void } {
  const events: OrchestratorEvent[] = [];
  return { events, sink: (e: OrchestratorEvent): void => void events.push(e) };
}

describe('runOrchestratorTick — events.jsonl emission', () => {
  it('happy path: Tick → Dispatched → Completed (with stamped runId + tick + ts)', async () => {
    const { events, sink } = captureSink();
    const config = defaultOrchestratorConfig({ workDir: '/tmp', maxConcurrent: 1, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-A']),
      dispatch: async (taskId) => approvedResult(taskId, 'https://github.com/x/y/pull/1'),
      escalate: async () => {},
      emitEvent: sink,
      runId: 'fixture-run-uuid',
    };
    await runOrchestratorTick(config, adapters, 7);

    const types = events.map((e) => e.type);
    expect(types).toEqual(['OrchestratorTick', 'OrchestratorDispatched', 'OrchestratorCompleted']);

    expect(events[0]).toMatchObject({
      type: 'OrchestratorTick',
      tick: 7,
      runId: 'fixture-run-uuid',
      candidates: 1,
    });
    expect(events[1]).toMatchObject({
      type: 'OrchestratorDispatched',
      taskId: 'AISDLC-A',
      tick: 7,
      runId: 'fixture-run-uuid',
    });
    expect(events[2]).toMatchObject({
      type: 'OrchestratorCompleted',
      taskId: 'AISDLC-A',
      outcome: 'approved',
      prUrl: 'https://github.com/x/y/pull/1',
      tick: 7,
      runId: 'fixture-run-uuid',
    });
    // ts stamped by the emitter when caller didn't pre-set it.
    for (const e of events) {
      expect(typeof e.ts).toBe('string');
      expect(e.ts.length).toBeGreaterThan(0);
    }
  });

  it('failure path: Tick → Dispatched → Failed (mode=UnknownFailureMode)', async () => {
    const { events, sink } = captureSink();
    const config = defaultOrchestratorConfig({ workDir: '/tmp', maxConcurrent: 1, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-FAIL']),
      dispatch: async () => {
        throw new Error('synthetic verification failure');
      },
      escalate: async () => {},
      emitEvent: sink,
      runId: 'r2',
    };
    await runOrchestratorTick(config, adapters, 1);

    const types = events.map((e) => e.type);
    expect(types).toEqual(['OrchestratorTick', 'OrchestratorDispatched', 'OrchestratorFailed']);
    expect(events[2]).toMatchObject({
      type: 'OrchestratorFailed',
      taskId: 'AISDLC-FAIL',
      mode: 'UnknownFailureMode',
      reason: 'synthetic verification failure',
      prUrl: null,
    });
  });

  it('needs-human-attention: emits Completed AND a synthetic Failed for label visibility', async () => {
    const { events, sink } = captureSink();
    const config = defaultOrchestratorConfig({ workDir: '/tmp', maxConcurrent: 1, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-NHA']),
      dispatch: async () => nhaResult('AISDLC-NHA', 'https://github.com/x/y/pull/42'),
      escalate: async () => {},
      emitEvent: sink,
      runId: 'r3',
    };
    await runOrchestratorTick(config, adapters, 1);

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'OrchestratorTick',
      'OrchestratorDispatched',
      'OrchestratorCompleted',
      'OrchestratorFailed',
    ]);
    expect(events[2]).toMatchObject({
      type: 'OrchestratorCompleted',
      outcome: 'needs-human-attention',
      prUrl: 'https://github.com/x/y/pull/42',
    });
    expect(events[3]).toMatchObject({
      type: 'OrchestratorFailed',
      taskId: 'AISDLC-NHA',
      mode: 'UnknownFailureMode',
      prUrl: 'https://github.com/x/y/pull/42',
    });
  });

  it('empty frontier: Tick + IdleNoWork', async () => {
    // Per the merged Phase 3 + Phase 4 wiring, the empty-frontier branch
    // also surfaces an `OrchestratorIdleNoWork` event on the bus so
    // operators can grep one stream for the idle cause (no work vs all
    // candidates filtered). The in-process `tickResult.idleEvent` carries
    // the same data for the `cli-orchestrator status` view.
    const { events, sink } = captureSink();
    const config = defaultOrchestratorConfig({ workDir: '/tmp', maxConcurrent: 1, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier([]),
      emitEvent: sink,
      runId: 'r4',
    };
    await runOrchestratorTick(config, adapters, 1);

    expect(events.map((e) => e.type)).toEqual(['OrchestratorTick', 'OrchestratorIdleNoWork']);
    expect(events[0]).toMatchObject({
      type: 'OrchestratorTick',
      tick: 1,
      candidates: 0,
    });
    expect(events[1]).toMatchObject({
      type: 'OrchestratorIdleNoWork',
      tick: 1,
      runId: 'r4',
    });
  });

  it('dry-run: Tick + IdleNoWork (no Dispatched even when the frontier has candidates)', async () => {
    // Dry-run short-circuits before the filter chain + dispatch; the loop
    // still emits the matching idle event so the events stream stays
    // honest about the orchestrator's heartbeat.
    const { events, sink } = captureSink();
    const config = defaultOrchestratorConfig({
      workDir: '/tmp',
      maxConcurrent: 5,
      dryRun: true,
      maxTicks: 1,
    });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-A', 'AISDLC-B']),
      dispatch: async (taskId) => approvedResult(taskId),
      emitEvent: sink,
      runId: 'r5',
    };
    await runOrchestratorTick(config, adapters, 1);

    expect(events.map((e) => e.type)).toEqual(['OrchestratorTick', 'OrchestratorIdleNoWork']);
    expect(events[0]).toMatchObject({ candidates: 2 });
    expect(events[1]).toMatchObject({
      type: 'OrchestratorIdleNoWork',
      runId: 'r5',
    });
  });

  it('best-effort: a thrown sink is swallowed (loop completes successfully)', async () => {
    const config = defaultOrchestratorConfig({ workDir: '/tmp', maxConcurrent: 1, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-A']),
      dispatch: async (taskId) => approvedResult(taskId),
      escalate: async () => {},
      emitEvent: (): void => {
        throw new Error('events bus exploded');
      },
      runId: 'r6',
    };
    // Must not throw — the emitter swallows.
    const result = await runOrchestratorTick(config, adapters, 1);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].outcome).toBe('approved');
  });
});
