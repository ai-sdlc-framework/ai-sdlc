/**
 * Bare-orchestrator-loop tests (RFC-0015 Phase 1 / AISDLC-169.1).
 *
 * Cover the four invariants the loop ships in Phase 1:
 *   1. Honors the `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` flag — loop refuses to
 *      start when unset.
 *   2. Drains a 5-task fixture queue end-to-end (acceptance criterion #10).
 *   3. Escalates 3 failure-injection tasks via the `UnknownFailureMode`
 *      escalation hook (acceptance criterion #10).
 *   4. SIGTERM drains the in-flight tick + exits cleanly.
 *
 * Also covers per-tick behaviours (empty frontier, dry-run, idempotent
 * `needs-human-attention` escalation, escalator throw).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOrchestratorStatus,
  defaultOrchestratorConfig,
  ORCHESTRATOR_FLAG,
  OrchestratorDisabledError,
  runOrchestratorLoop,
  runOrchestratorTick,
  type OrchestratorAdapters,
} from './index.js';
import type { EscalationRecord } from './types.js';
import type { PipelineResult, PipelineLogger } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────

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

/**
 * Phase 3 adds three pre-dispatch filters that read disk by default
 * (graph from `<workDir>/backlog/`, DoR verdicts from
 * `$ARTIFACTS_DIR/_dor/calibration.jsonl`, etc.). These Phase 1 tests
 * use a synthetic `frontier` adapter and expect those candidates to be
 * dispatched without consulting disk. Inject hermetic filter adapters so
 * the chain admits everything from the synthetic frontier without
 * reading any real-on-disk state.
 */
function hermeticFilterAdapters(): Pick<
  OrchestratorAdapters,
  'graphLoader' | 'taskLabelsLoader' | 'calibrationLogPath'
> {
  return {
    graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
    taskLabelsLoader: () => [],
    // Pointing at an absent path makes the DoR filter return PASS by
    // construction (per its module-level docstring's no-log default).
    calibrationLogPath: '/nonexistent-phase1-tests-bypass.jsonl',
  };
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

function needsAttentionResult(taskId: string, prUrl: string | null = null): PipelineResult {
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

function originalEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

// ── Suite ─────────────────────────────────────────────────────────────

describe('runOrchestratorLoop — feature flag enforcement', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = originalEnv();
  });
  afterEach(() => {
    process.env = saved;
  });

  it('refuses to start when the feature flag is unset', async () => {
    delete process.env[ORCHESTRATOR_FLAG];
    const config = defaultOrchestratorConfig({ workDir: '/tmp', maxTicks: 1 });
    await expect(runOrchestratorLoop(config, { logger: silentLogger() })).rejects.toBeInstanceOf(
      OrchestratorDisabledError,
    );
  });

  it('refuses to start when the flag value is not in the truthy set', async () => {
    process.env[ORCHESTRATOR_FLAG] = 'maybe';
    const config = defaultOrchestratorConfig({ workDir: '/tmp', maxTicks: 1 });
    await expect(runOrchestratorLoop(config, { logger: silentLogger() })).rejects.toBeInstanceOf(
      OrchestratorDisabledError,
    );
  });

  it('starts when the flag is `experimental`', async () => {
    process.env[ORCHESTRATOR_FLAG] = 'experimental';
    const config = defaultOrchestratorConfig({
      workDir: '/tmp',
      maxTicks: 1,
      tickIntervalSec: 0,
    });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier([]),
      sleep: () => Promise.resolve(),
    };
    const ticks = await runOrchestratorLoop(config, adapters);
    expect(ticks).toHaveLength(1);
    expect(ticks[0].empty).toBe(true);
  });
});

describe('runOrchestratorTick — happy path', () => {
  it('returns empty=true when the frontier has no candidates', async () => {
    const config = defaultOrchestratorConfig({ workDir: '/tmp', maxTicks: 1 });
    const result = await runOrchestratorTick(
      config,
      { logger: silentLogger(), frontier: fakeFrontier([]) },
      1,
    );
    expect(result.empty).toBe(true);
    expect(result.dispatched).toEqual([]);
    expect(result.outcomes).toEqual([]);
    expect(result.escalations).toEqual([]);
  });

  it('dispatches up to maxConcurrent tasks per tick', async () => {
    const dispatched: string[] = [];
    const config = defaultOrchestratorConfig({
      workDir: '/tmp',
      maxConcurrent: 2,
      maxTicks: 1,
    });
    const result = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        frontier: fakeFrontier(['AISDLC-A', 'AISDLC-B', 'AISDLC-C']),
        dispatch: async (taskId) => {
          dispatched.push(taskId);
          return approvedResult(taskId, `https://github.com/x/y/pull/1#${taskId}`);
        },
        ...hermeticFilterAdapters(),
      },
      1,
    );
    expect(dispatched).toEqual(['AISDLC-A', 'AISDLC-B']);
    expect(result.dispatched).toEqual(['AISDLC-A', 'AISDLC-B']);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.every((o) => o.outcome === 'approved')).toBe(true);
    expect(result.escalations).toEqual([]);
  });

  it('honors --dry-run by skipping dispatch even with non-empty frontier', async () => {
    let dispatchedCount = 0;
    const config = defaultOrchestratorConfig({
      workDir: '/tmp',
      maxConcurrent: 5,
      dryRun: true,
      maxTicks: 1,
    });
    const result = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        frontier: fakeFrontier(['AISDLC-A', 'AISDLC-B']),
        dispatch: async (taskId) => {
          dispatchedCount += 1;
          return approvedResult(taskId);
        },
        ...hermeticFilterAdapters(),
      },
      1,
    );
    expect(dispatchedCount).toBe(0);
    expect(result.dispatched).toEqual([]);
    expect(result.candidates).toBe(2);
    expect(result.empty).toBe(false);
  });
});

describe('runOrchestratorTick — failure escalation', () => {
  it('escalates when dispatch throws (UnknownFailureMode)', async () => {
    const escalations: EscalationRecord[] = [];
    const config = defaultOrchestratorConfig({
      workDir: '/tmp',
      maxConcurrent: 1,
      maxTicks: 1,
    });
    const result = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        frontier: fakeFrontier(['AISDLC-FAIL']),
        dispatch: async () => {
          throw new Error('synthetic verification failure');
        },
        escalate: async (taskId, reason, prUrl) => {
          escalations.push({
            taskId,
            ts: '2026-05-02T00:00:00Z',
            event: 'UnknownFailureMode',
            reason,
            prUrl,
          });
        },
        ...hermeticFilterAdapters(),
      },
      1,
    );
    expect(result.escalations).toHaveLength(1);
    expect(result.escalations[0].event).toBe('UnknownFailureMode');
    expect(result.escalations[0].reason).toContain('synthetic verification failure');
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].outcome).toBe('unknown-failure');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].taskId).toBe('AISDLC-FAIL');
  });

  it('escalates when executePipeline returns needs-human-attention (Q1 layer A — durable PR label)', async () => {
    const labelled: Array<{ taskId: string; prUrl: string | null }> = [];
    const config = defaultOrchestratorConfig({
      workDir: '/tmp',
      maxConcurrent: 1,
      maxTicks: 1,
    });
    const result = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        frontier: fakeFrontier(['AISDLC-NHA']),
        dispatch: async () => needsAttentionResult('AISDLC-NHA', 'https://github.com/x/y/pull/42'),
        escalate: async (taskId, _reason, prUrl) => {
          labelled.push({ taskId, prUrl });
        },
        ...hermeticFilterAdapters(),
      },
      1,
    );
    expect(result.escalations).toHaveLength(1);
    expect(result.outcomes[0].outcome).toBe('needs-human-attention');
    expect(labelled).toEqual([{ taskId: 'AISDLC-NHA', prUrl: 'https://github.com/x/y/pull/42' }]);
  });

  it('survives an escalator that throws (escalation absorbed, loop unaffected)', async () => {
    const config = defaultOrchestratorConfig({
      workDir: '/tmp',
      maxConcurrent: 1,
      maxTicks: 1,
    });
    const result = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        frontier: fakeFrontier(['AISDLC-ESCFAIL']),
        dispatch: async () => {
          throw new Error('dispatch boom');
        },
        escalate: async () => {
          throw new Error('gh pr edit network down');
        },
        ...hermeticFilterAdapters(),
      },
      1,
    );
    expect(result.escalations).toHaveLength(1);
    expect(result.escalations[0].reason).toContain('dispatch boom');
    expect(result.escalations[0].reason).toContain('escalator threw');
  });

  it('escalates when dispatch returns no result (defensive coverage)', async () => {
    const config = defaultOrchestratorConfig({
      workDir: '/tmp',
      maxConcurrent: 1,
      maxTicks: 1,
    });
    const result = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        frontier: fakeFrontier(['AISDLC-NULL']),
        // Cast: production DispatchFn always returns a PipelineResult, but we
        // exercise the defensive branch to prove a future regression that
        // returns nullish doesn't silently drop the task.
        dispatch: (async () => undefined) as unknown as OrchestratorAdapters['dispatch'],
        escalate: async () => {},
        ...hermeticFilterAdapters(),
      },
      1,
    );
    expect(result.escalations).toHaveLength(1);
    expect(result.escalations[0].reason).toContain('no result');
    expect(result.outcomes[0].outcome).toBe('unknown-failure');
  });
});

describe('runOrchestratorLoop — fixture queue acceptance (criterion #10)', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = originalEnv();
    process.env[ORCHESTRATOR_FLAG] = 'experimental';
  });
  afterEach(() => {
    process.env = saved;
  });

  it('drains a 5-task fixture queue end-to-end with maxConcurrent=1', async () => {
    // Simulated frontier: each tick pops the front task once it's dispatched.
    const queue = ['AISDLC-1', 'AISDLC-2', 'AISDLC-3', 'AISDLC-4', 'AISDLC-5'];
    const completed: string[] = [];

    const config = defaultOrchestratorConfig({
      workDir: '/tmp',
      maxConcurrent: 1,
      tickIntervalSec: 0,
      maxTicks: 6, // 5 dispatches + 1 trailing empty tick to prove drain
    });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => queue.map((id) => ({ id, title: `Task ${id}` })),
      dispatch: async (taskId: string) => {
        completed.push(taskId);
        // Pop the dispatched task off the queue so the next tick sees the
        // remaining frontier — same behaviour the real cli-deps frontier
        // produces once a task moves to backlog/completed/.
        const i = queue.indexOf(taskId);
        if (i >= 0) queue.splice(i, 1);
        return approvedResult(taskId, `https://github.com/x/y/pull/${taskId}`);
      },
      escalate: async () => {},
      ...hermeticFilterAdapters(),
    };

    const ticks = await runOrchestratorLoop(config, adapters);
    expect(completed).toEqual(['AISDLC-1', 'AISDLC-2', 'AISDLC-3', 'AISDLC-4', 'AISDLC-5']);
    expect(ticks.filter((t) => t.dispatched.length > 0)).toHaveLength(5);
    expect(ticks[ticks.length - 1].empty).toBe(true);
    expect(ticks.flatMap((t) => t.escalations)).toEqual([]);
  });

  it('routes 3 failure-injection tasks cleanly through UnknownFailureMode', async () => {
    // Three failure modes per Phase 1 acceptance:
    //   1. synthetic verification fail — dispatch throws
    //   2. synthetic git push fail — dispatch returns needs-human-attention
    //   3. synthetic missing-reference — dispatch throws with a different message
    type Scenario = 'verify-fail' | 'push-fail' | 'missing-ref';
    const queue: Array<{ id: string; scenario: Scenario }> = [
      { id: 'AISDLC-VF', scenario: 'verify-fail' },
      { id: 'AISDLC-PF', scenario: 'push-fail' },
      { id: 'AISDLC-MR', scenario: 'missing-ref' },
    ];
    const escalations: EscalationRecord[] = [];

    const config = defaultOrchestratorConfig({
      workDir: '/tmp',
      maxConcurrent: 1,
      tickIntervalSec: 0,
      maxTicks: 4,
    });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: () => Promise.resolve(),
      frontier: () => queue.map((q) => ({ id: q.id, title: q.id })),
      dispatch: async (taskId: string) => {
        const entry = queue.find((q) => q.id === taskId);
        // Pop on dispatch (same as in the success path).
        if (entry) queue.splice(queue.indexOf(entry), 1);
        if (!entry) throw new Error(`unknown task ${taskId}`);
        switch (entry.scenario) {
          case 'verify-fail':
            throw new Error('verification failed: pnpm test exit 1');
          case 'push-fail':
            // Push-fail looks like an executePipeline native escalation —
            // it returns needs-human-attention with a PR URL the orchestrator
            // can label.
            return needsAttentionResult(taskId, `https://github.com/x/y/pull/${taskId}`);
          case 'missing-ref':
            throw new Error('missing reference: backlog/tasks/foo.md not found');
        }
      },
      escalate: async (taskId: string, reason: string, prUrl: string | null) => {
        escalations.push({
          taskId,
          ts: '2026-05-02T00:00:00Z',
          event: 'UnknownFailureMode',
          reason,
          prUrl,
        });
      },
      ...hermeticFilterAdapters(),
    };

    const ticks = await runOrchestratorLoop(config, adapters);
    expect(escalations).toHaveLength(3);
    expect(escalations.map((e) => e.taskId).sort()).toEqual([
      'AISDLC-MR',
      'AISDLC-PF',
      'AISDLC-VF',
    ]);
    // The verify-fail + missing-ref scenarios escalate without a PR URL
    // (dispatch threw before any push). The push-fail scenario escalates with
    // the PR URL so the durable label can attach.
    const pf = escalations.find((e) => e.taskId === 'AISDLC-PF');
    expect(pf?.prUrl).toMatch(/AISDLC-PF$/);
    const vf = escalations.find((e) => e.taskId === 'AISDLC-VF');
    expect(vf?.prUrl).toBeNull();
    // Loop never crashed despite repeated failures — every scenario produced
    // its own tick result.
    expect(ticks.filter((t) => t.escalations.length > 0)).toHaveLength(3);
  });
});

describe('runOrchestratorLoop — SIGTERM drain', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = originalEnv();
    process.env[ORCHESTRATOR_FLAG] = 'experimental';
  });
  afterEach(() => {
    process.env = saved;
  });

  it('exits the loop after the in-flight tick when SIGTERM arrives', async () => {
    let dispatched = 0;
    const config = defaultOrchestratorConfig({
      workDir: '/tmp',
      maxConcurrent: 1,
      tickIntervalSec: 0,
      maxTicks: 100, // would run forever without SIGTERM
    });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: async () => {
        // After the first tick, fire SIGTERM during the inter-tick sleep
        // so the next iteration sees `shouldStop=true` and breaks cleanly.
        process.emit('SIGTERM' as NodeJS.Signals);
      },
      frontier: fakeFrontier(['AISDLC-X']),
      dispatch: async (taskId: string) => {
        dispatched += 1;
        return approvedResult(taskId);
      },
      escalate: async () => {},
      ...hermeticFilterAdapters(),
    };
    const ticks = await runOrchestratorLoop(config, adapters);
    expect(dispatched).toBeGreaterThanOrEqual(1);
    // Loop drained — at most a handful of ticks ran, NOT the full 100 cap.
    expect(ticks.length).toBeLessThan(5);
  });
});

describe('buildOrchestratorStatus', () => {
  it('returns frontier + queue depth + flag state without dispatching', async () => {
    const dispatchSpy = vi.fn();
    const status = await buildOrchestratorStatus(defaultOrchestratorConfig({ workDir: '/tmp' }), {
      frontier: fakeFrontier(['AISDLC-A', 'AISDLC-B']),
      dispatch: dispatchSpy,
    });
    expect(status.queueDepth).toBe(2);
    expect(status.frontier).toEqual([
      { id: 'AISDLC-A', title: 'Task AISDLC-A' },
      { id: 'AISDLC-B', title: 'Task AISDLC-B' },
    ]);
    expect(dispatchSpy).not.toHaveBeenCalled();
    // `enabled` reflects current env — we don't mutate it here, so accept either.
    expect(typeof status.enabled).toBe('boolean');
  });
});
