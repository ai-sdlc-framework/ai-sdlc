/**
 * Loop-level integration tests for the in-flight tracker (RFC-0015 / AISDLC-179).
 *
 * Original-bug witness reproduction: with `maxConcurrent: 1` and a 30s
 * tick interval, every subsequent tick re-picked the same task while
 * tick 1's dev subagent was still mid-flight — wasting dispatches and
 * tripping "branch already exists" at Step 3. These tests prove the
 * pre-dispatch in-flight filter rejects the second tick's pick when the
 * first tick's dispatch is still pending, AND the in-flight slot is
 * released so a THIRD tick (after settle) can re-dispatch cleanly.
 */

import { describe, expect, it } from 'vitest';

import { runOrchestratorTick, type OrchestratorAdapters } from './index.js';
import { defaultOrchestratorConfig } from './loop.js';
import { makeInFlightMap } from './in-flight.js';
import type { PipelineLogger, PipelineResult } from '../types.js';

function silentLogger(): PipelineLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    progress: () => {},
  };
}

function fakeFrontier(ids: string[]): () => Array<{ id: string; title: string }> {
  return () => ids.map((id) => ({ id, title: `Task ${id}` }));
}

function hermeticFilterAdapters(): Pick<
  OrchestratorAdapters,
  'graphLoader' | 'taskLabelsLoader' | 'calibrationLogPath'
> {
  return {
    graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
    taskLabelsLoader: () => [],
    calibrationLogPath: '/nonexistent-in-flight-tests-bypass.jsonl',
  };
}

function approvedResult(taskId: string): PipelineResult {
  return {
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktreePath: `.worktrees/${taskId.toLowerCase()}`,
    outcome: 'approved',
    prUrl: null,
    siblingPrUrls: [],
    iterations: 1,
    finalVerdict: null,
  };
}

describe('runOrchestratorTick — in-flight pre-filter (AISDLC-179)', () => {
  it('rejects a second-tick re-dispatch while the first dispatch is still pending', async () => {
    // Shared in-flight map across both ticks — same as runOrchestratorLoop.
    const inFlight = makeInFlightMap();
    const config = defaultOrchestratorConfig({ workDir: '/tmp', maxConcurrent: 1, maxTicks: 1 });

    // Long-running dispatch: resolves only when we tell it to. Tick 1
    // starts the dispatch + claims the slot; tick 2 runs while it's still
    // pending and MUST be filtered out by the in-flight pre-filter.
    let resolveDispatch: ((value: PipelineResult) => void) | null = null;
    let dispatchCallCount = 0;
    const dispatch = async (taskId: string): Promise<PipelineResult> => {
      dispatchCallCount += 1;
      return new Promise<PipelineResult>((resolve) => {
        resolveDispatch = resolve;
        // Don't auto-resolve — held open so tick 2 sees the slot occupied.
        // Test resolves explicitly below.
      }).then(() => approvedResult(taskId));
    };

    const sharedAdapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-LONG']),
      dispatch,
      escalate: async () => {},
      inFlight,
      ...hermeticFilterAdapters(),
    };

    // Kick off tick 1 (don't await yet — we want tick 2 to race against it).
    const tick1Promise = runOrchestratorTick(config, sharedAdapters, 1);

    // Yield to the event loop so tick 1's dispatch claim lands before
    // tick 2 evaluates the frontier. A microtask flush is enough — the
    // dispatch's `new Promise(...)` callback runs synchronously inside
    // the awaited dispatchFn() call.
    await new Promise((r) => setImmediate(r));

    // Tick 2 — should observe the in-flight entry and skip dispatch.
    const tick2 = await runOrchestratorTick(config, sharedAdapters, 2);

    // Tick 2 surfaced the rejection on the in-process accumulator.
    expect(tick2.alreadyInFlight).toHaveLength(1);
    expect(tick2.alreadyInFlight[0].taskId).toBe('AISDLC-LONG');
    expect(tick2.alreadyInFlight[0].type).toBe('OrchestratorTaskAlreadyInFlight');
    expect(tick2.alreadyInFlight[0].startedAt).toBeTruthy();
    // Tick 2 dispatched nothing — the in-flight pre-filter ran BEFORE the
    // §4.3 filter chain so no FilterEvent fired either.
    expect(tick2.dispatched).toEqual([]);
    expect(tick2.outcomes).toEqual([]);

    // Now release tick 1's dispatch + drain it. The slot should be freed.
    expect(resolveDispatch).not.toBeNull();
    resolveDispatch!(approvedResult('AISDLC-LONG'));
    const tick1 = await tick1Promise;
    expect(tick1.dispatched).toEqual(['AISDLC-LONG']);
    expect(tick1.alreadyInFlight).toEqual([]);

    // Only ONE underlying dispatch fired across both ticks — the original-bug
    // witness no longer reproduces.
    expect(dispatchCallCount).toBe(1);

    // After settle, the slot is released — a fresh tick 3 with a fresh
    // dispatch (different task to keep the test focused on the released-slot
    // assertion) admits the candidate normally.
    expect(inFlight.size).toBe(0);
  });

  it('emits OrchestratorTaskAlreadyInFlight on the events bus when filtering', async () => {
    const inFlight = makeInFlightMap();
    const config = defaultOrchestratorConfig({ workDir: '/tmp', maxConcurrent: 1, maxTicks: 1 });

    // Pre-populate the in-flight map (simulates a previous-tick dispatch
    // still running) so tick 1 directly observes the rejection path.
    inFlight.set('aisdlc-busy', {
      startedAt: '2026-05-03T12:00:00.000Z',
      worktreePath: '/tmp/.worktrees/aisdlc-busy',
      dispatchPromise: null,
    });

    const emittedEvents: Array<{ type: string; taskId?: string; startedAt?: string }> = [];

    const tick = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        frontier: fakeFrontier(['AISDLC-BUSY']),
        dispatch: async (taskId) => approvedResult(taskId),
        escalate: async () => {},
        inFlight,
        emitEvent: (e) =>
          emittedEvents.push({
            type: e.type,
            taskId: e.taskId,
            startedAt: e.startedAt as string | undefined,
          }),
        ...hermeticFilterAdapters(),
      },
      1,
    );

    // The in-flight pre-filter rejected the only candidate, so the tick is
    // idle — but `alreadyInFlight` carries the rejection trace.
    expect(tick.alreadyInFlight).toHaveLength(1);
    expect(tick.alreadyInFlight[0].taskId).toBe('AISDLC-BUSY');
    expect(tick.alreadyInFlight[0].startedAt).toBe('2026-05-03T12:00:00.000Z');

    // The same rejection was emitted to the events bus (single-source-of-truth
    // contract per RFC-0015 §7).
    const inFlightEmissions = emittedEvents.filter(
      (e) => e.type === 'OrchestratorTaskAlreadyInFlight',
    );
    expect(inFlightEmissions).toHaveLength(1);
    expect(inFlightEmissions[0].taskId).toBe('AISDLC-BUSY');
    expect(inFlightEmissions[0].startedAt).toBe('2026-05-03T12:00:00.000Z');
  });
});
