/**
 * AISDLC-229 — hermetic tests for the new `umbrellaDispatch` wiring in
 * `runOrchestratorTick`.
 *
 * These tests cover:
 *   1. Success path: umbrella returns ok=true → outcomes[i].pipeline is
 *      populated, outcomes[i].failure is absent.
 *   2. Failure path: umbrella returns ok=false → outcomes[i].failure is
 *      populated with the right failure type, outcome is the matching
 *      PipelineOutcome.
 *   3. Spawner-fallback (AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key):
 *      when the first claude-cli attempt fails with a spawner-unavailable
 *      reason, the umbrella retries with api-key.
 *   4. Backward-compat: existing `dispatch` adapter (legacy DispatchFn)
 *      continues to work unchanged — pipeline/failure fields remain undefined.
 *   5. tick output schema unchanged: dispatched/outcomes/escalations/idleEvent
 *      shape matches the existing contract.
 *
 * All tests use hermetic stubs and never touch the filesystem or spawn real
 * processes (AC #6 compliance).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrchestratorTick, type OrchestratorAdapters } from './index.js';
import { defaultOrchestratorConfig, ORCHESTRATOR_SPAWNER_ENV } from './loop.js';
import type { PipelineLogger, PipelineResult } from '../types.js';
import type { ExecuteCommandResult } from '../cli/execute.js';
import type { RichDispatchResult } from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

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
 * Hermetic filter adapters that admit every candidate without disk I/O.
 * Required for all tests — the admission filters need either a real backlog
 * dir or these stubs.
 */
function hermeticFilterAdapters(): Pick<
  OrchestratorAdapters,
  'graphLoader' | 'taskLabelsLoader' | 'calibrationLogPath' | 'parentBranchGuard'
> {
  return {
    graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
    taskLabelsLoader: () => [],
    calibrationLogPath: '/nonexistent-aisdlc-229-bypass.jsonl',
    // Explicitly stub out the parent-branch guard so tests are hermetic
    // regardless of whether /tmp happens to be inside a git repo.
    parentBranchGuard: async () => {},
  };
}

/**
 * Build a synthetic `PipelineResult` for the given outcome. Used by both
 * the legacy-dispatch and the umbrella-dispatch stubs.
 */
function pipelineResult(
  taskId: string,
  outcome: PipelineResult['outcome'] = 'approved',
  prUrl: string | null = `https://github.com/org/repo/pull/42`,
): PipelineResult {
  return {
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktreePath: `.worktrees/${taskId.toLowerCase()}`,
    outcome,
    prUrl,
    siblingPrUrls: [],
    iterations: 1,
    finalVerdict: null,
  };
}

/**
 * Build a synthetic `ExecuteCommandResult` for the success path.
 * Includes a mock `finalVerdict` with three approved reviewer verdicts so
 * the `extractPipelineDetail` helper can populate `reviewerVerdicts`.
 */
function successExecResult(
  taskId: string,
  prUrl = 'https://github.com/org/repo/pull/42',
): ExecuteCommandResult {
  return {
    ok: true,
    pipeline: {
      taskId,
      branch: `ai-sdlc/${taskId.toLowerCase()}`,
      worktreePath: `.worktrees/${taskId.toLowerCase()}`,
      outcome: 'approved',
      prUrl,
      siblingPrUrls: [],
      iterations: 2,
      finalVerdict: {
        decision: 'APPROVED',
        approved: true,
        harnessNote: 'all reviewers approved',
        summary: 'lgtm',
        counts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        verdicts: [
          {
            agentId: 'code-reviewer',
            harness: 'claude-code',
            approved: true,
            findings: [],
            summary: 'lgtm',
          },
          {
            agentId: 'test-reviewer',
            harness: 'claude-code',
            approved: true,
            findings: [],
            summary: 'lgtm',
          },
          {
            agentId: 'security-reviewer',
            harness: 'claude-code',
            approved: true,
            findings: [],
            summary: 'lgtm',
          },
        ],
      },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('runOrchestratorTick — umbrella dispatch (AISDLC-229)', () => {
  const config = defaultOrchestratorConfig({ workDir: '/tmp', maxConcurrent: 1, maxTicks: 1 });

  // ── AC #6 / AC #3: success path ────────────────────────────────────────

  it('populates outcomes[i].pipeline when umbrella succeeds (success path)', async () => {
    const taskId = 'AISDLC-229-A';

    const umbrellaDispatch = async (): Promise<RichDispatchResult> => {
      const execResult = successExecResult(taskId);
      return {
        result: pipelineResult(taskId, 'approved', execResult.pipeline!.prUrl),
        pipeline: {
          attestationSha: null,
          prNumber: 42,
          reviewerVerdicts: { code: 'approved', test: 'approved', security: 'approved' },
          iterations: 2,
        },
      };
    };

    const tick = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        frontier: fakeFrontier([taskId]),
        umbrellaDispatch,
        escalate: async () => {},
        ...hermeticFilterAdapters(),
      },
      1,
    );

    // AC #3: shape unchanged
    expect(tick.dispatched).toEqual([taskId]);
    expect(tick.outcomes).toHaveLength(1);
    expect(tick.escalations).toEqual([]);

    const outcome = tick.outcomes[0];
    // AC #4: pipeline fields present
    expect(outcome.pipeline).toBeDefined();
    expect(outcome.pipeline!.prNumber).toBe(42);
    expect(outcome.pipeline!.reviewerVerdicts).toEqual({
      code: 'approved',
      test: 'approved',
      security: 'approved',
    });
    expect(outcome.pipeline!.iterations).toBe(2);
    // AC #5: no failure on success
    expect(outcome.failure).toBeUndefined();
    expect(outcome.outcome).toBe('approved');
    expect(outcome.prUrl).toBe('https://github.com/org/repo/pull/42');
  });

  // ── AC #5 / AC #6: failure path ────────────────────────────────────────

  it('populates outcomes[i].failure when umbrella reports developer-failed', async () => {
    const taskId = 'AISDLC-229-B';

    const umbrellaDispatch = async (): Promise<RichDispatchResult> => ({
      result: pipelineResult(taskId, 'developer-failed', null),
      failure: { type: 'developer-failed', message: 'developer returned commitSha: null' },
    });

    const tick = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        frontier: fakeFrontier([taskId]),
        umbrellaDispatch,
        escalate: async () => {},
        ...hermeticFilterAdapters(),
      },
      1,
    );

    // AC #3: shape unchanged — dispatched + outcomes present
    expect(tick.dispatched).toEqual([taskId]);
    expect(tick.outcomes).toHaveLength(1);

    const outcome = tick.outcomes[0];
    // AC #5: failure is recorded, tick did NOT throw
    expect(outcome.failure).toBeDefined();
    expect(outcome.failure!.type).toBe('developer-failed');
    expect(outcome.failure!.message).toContain('commitSha');
    expect(outcome.outcome).toBe('developer-failed');
    // No pipeline detail on a pre-review failure
    expect(outcome.pipeline).toBeUndefined();
    // AC #5: escalation fired (developer-failed → ROLLBACK_OUTCOMES)
    expect(tick.escalations).toHaveLength(0); // developer-failed doesn't auto-escalate (no needs-human-attention)
  });

  it('populates outcomes[i].failure when umbrella reports unknown failure', async () => {
    const taskId = 'AISDLC-229-C';

    const umbrellaDispatch = async (): Promise<RichDispatchResult> => ({
      result: pipelineResult(taskId, 'aborted', null),
      failure: { type: 'unknown', message: 'unexpected error from umbrella' },
    });

    const tick = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        frontier: fakeFrontier([taskId]),
        umbrellaDispatch,
        escalate: async () => {},
        ...hermeticFilterAdapters(),
      },
      1,
    );

    expect(tick.dispatched).toEqual([taskId]);
    const outcome = tick.outcomes[0];
    expect(outcome.failure).toBeDefined();
    expect(outcome.failure!.type).toBe('unknown');
    expect(outcome.outcome).toBe('aborted');
  });

  // ── AC #5: tick never blocks on umbrella failure ───────────────────────

  it('continues to the next admitted task when first umbrella fails (AC #5)', async () => {
    const config2 = defaultOrchestratorConfig({ workDir: '/tmp', maxConcurrent: 2, maxTicks: 1 });
    const taskA = 'AISDLC-229-FAIL';
    const taskB = 'AISDLC-229-PASS';

    const umbrellaDispatch = async (taskId: string): Promise<RichDispatchResult> => {
      if (taskId === taskA) {
        return {
          result: pipelineResult(taskA, 'aborted', null),
          failure: { type: 'unknown', message: 'umbrella crashed for first task' },
        };
      }
      return {
        result: pipelineResult(taskB, 'approved'),
        pipeline: {
          attestationSha: null,
          prNumber: 99,
          reviewerVerdicts: { code: 'approved', test: 'approved', security: 'approved' },
          iterations: 1,
        },
      };
    };

    const tick = await runOrchestratorTick(
      config2,
      {
        logger: silentLogger(),
        frontier: fakeFrontier([taskA, taskB]),
        umbrellaDispatch,
        escalate: async () => {},
        ...hermeticFilterAdapters(),
      },
      1,
    );

    // Both tasks dispatched — tick never blocked on the first failure.
    expect(tick.dispatched).toHaveLength(2);
    expect(tick.dispatched).toContain(taskA);
    expect(tick.dispatched).toContain(taskB);

    const failedOutcome = tick.outcomes.find((o) => o.taskId === taskA);
    const passedOutcome = tick.outcomes.find((o) => o.taskId === taskB);

    expect(failedOutcome?.failure?.type).toBe('unknown');
    expect(passedOutcome?.pipeline?.prNumber).toBe(99);
    expect(passedOutcome?.failure).toBeUndefined();
  });

  // ── AC #3: backward-compat with legacy dispatch adapter ───────────────

  it('backward-compat: legacy dispatch adapter leaves pipeline/failure undefined', async () => {
    const taskId = 'AISDLC-229-LEGACY';

    // Use the OLD legacy `dispatch` adapter (plain DispatchFn).
    const dispatch = async (): Promise<PipelineResult> => pipelineResult(taskId, 'approved');

    const tick = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        frontier: fakeFrontier([taskId]),
        dispatch, // legacy path — no umbrellaDispatch
        escalate: async () => {},
        ...hermeticFilterAdapters(),
      },
      1,
    );

    expect(tick.dispatched).toEqual([taskId]);
    const outcome = tick.outcomes[0];
    expect(outcome.outcome).toBe('approved');
    // Legacy path: extra fields absent (backward-compatible)
    expect(outcome.pipeline).toBeUndefined();
    expect(outcome.failure).toBeUndefined();
  });

  // ── buildDefaultUmbrellaDispatch: spawner-kind defaults ───────────────

  it('buildDefaultUmbrellaDispatch: umbrellaExecutor stub is used when injected', async () => {
    const taskId = 'AISDLC-229-EXEC';
    const calls: Array<{ taskId: string; spawnerKind: string }> = [];

    // Inject a stub via `umbrellaExecutor` (the injectable adapter for tests
    // that want to exercise the default-dispatch code path without the flag).
    const umbrellaExecutor = async (t: string, k: string): Promise<ExecuteCommandResult> => {
      calls.push({ taskId: t, spawnerKind: k });
      return successExecResult(t);
    };

    const tick = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        frontier: fakeFrontier([taskId]),
        umbrellaExecutor: umbrellaExecutor as unknown as OrchestratorAdapters['umbrellaExecutor'],
        escalate: async () => {},
        ...hermeticFilterAdapters(),
      },
      1,
    );

    // umbrellaExecutor was called exactly once with the default spawner kind.
    expect(calls).toHaveLength(1);
    expect(calls[0].taskId).toBe(taskId);
    expect(calls[0].spawnerKind).toBe('claude-cli'); // default

    expect(tick.dispatched).toEqual([taskId]);
    const outcome = tick.outcomes[0];
    // pipeline detail was extracted from the success exec result
    expect(outcome.pipeline).toBeDefined();
    expect(outcome.pipeline!.reviewerVerdicts).toEqual({
      code: 'approved',
      test: 'approved',
      security: 'approved',
    });
    expect(outcome.pipeline!.iterations).toBe(2);
  });

  it('uses AI_SDLC_ORCHESTRATOR_SPAWNER=codex for the default umbrella executor', async () => {
    const previousSpawner = process.env[ORCHESTRATOR_SPAWNER_ENV];
    const previousUseUmbrella = process.env.AI_SDLC_ORCHESTRATOR_USE_UMBRELLA;
    delete process.env.AI_SDLC_ORCHESTRATOR_USE_UMBRELLA;
    process.env[ORCHESTRATOR_SPAWNER_ENV] = 'codex';

    try {
      const taskId = 'AISDLC-326-ENV-CODEX';
      const calls: Array<{ taskId: string; spawnerKind: string }> = [];

      const umbrellaExecutor = async (t: string, k: string): Promise<ExecuteCommandResult> => {
        calls.push({ taskId: t, spawnerKind: k });
        return successExecResult(t);
      };

      const tick = await runOrchestratorTick(
        config,
        {
          logger: silentLogger(),
          frontier: fakeFrontier([taskId]),
          umbrellaExecutor: umbrellaExecutor as unknown as OrchestratorAdapters['umbrellaExecutor'],
          escalate: async () => {},
          ...hermeticFilterAdapters(),
        },
        1,
      );

      expect(calls).toEqual([{ taskId, spawnerKind: 'codex' }]);
      expect(tick.dispatched).toEqual([taskId]);
      expect(tick.outcomes[0].outcome).toBe('approved');
    } finally {
      if (previousSpawner === undefined) {
        delete process.env[ORCHESTRATOR_SPAWNER_ENV];
      } else {
        process.env[ORCHESTRATOR_SPAWNER_ENV] = previousSpawner;
      }
      if (previousUseUmbrella === undefined) {
        delete process.env.AI_SDLC_ORCHESTRATOR_USE_UMBRELLA;
      } else {
        process.env.AI_SDLC_ORCHESTRATOR_USE_UMBRELLA = previousUseUmbrella;
      }
    }
  });

  it('surfaces missing CODEX_SPAWN_AGENT_BIN as spawner-unavailable before rollback work', async () => {
    const taskId = 'AISDLC-326-CODEX-MISSING-BRIDGE';
    const umbrellaExecutor = async (): Promise<ExecuteCommandResult> => ({
      ok: false,
      reason:
        '`--spawner codex` requires CODEX_SPAWN_AGENT_BIN in the environment before dispatch.',
    });

    const tick = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        frontier: fakeFrontier([taskId]),
        umbrellaSpawnerKind: 'codex',
        umbrellaExecutor: umbrellaExecutor as unknown as OrchestratorAdapters['umbrellaExecutor'],
        escalate: async () => {},
        ...hermeticFilterAdapters(),
      },
      1,
    );

    expect(tick.dispatched).toEqual([taskId]);
    const outcome = tick.outcomes[0];
    expect(outcome.failure?.type).toBe('spawner-unavailable');
    expect(outcome.failure?.message).toContain('CODEX_SPAWN_AGENT_BIN');
    expect(outcome.pipeline).toBeUndefined();
  });

  // ── AC #2: spawner fallback ────────────────────────────────────────────

  describe('spawner-fallback (AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key)', () => {
    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env.AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK;
    });

    afterEach(() => {
      if (savedEnv === undefined) {
        delete process.env.AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK;
      } else {
        process.env.AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK = savedEnv;
      }
    });

    it('falls back to api-key when claude-cli spawner fails with spawner-unavailable reason', async () => {
      process.env.AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK = 'api-key';
      const taskId = 'AISDLC-229-FALLBACK';
      const calls: Array<string> = [];

      const umbrellaExecutor = async (t: string, kind: string): Promise<ExecuteCommandResult> => {
        calls.push(kind);
        if (kind === 'claude-cli') {
          // Simulate spawner-unavailable: AISDLC-225 consumer bridge missing.
          return {
            ok: false,
            reason: 'claude-cli spawner: manifest not consumed by slash command body',
          };
        }
        // api-key fallback succeeds
        return successExecResult(t);
      };

      const tick = await runOrchestratorTick(
        config,
        {
          logger: silentLogger(),
          frontier: fakeFrontier([taskId]),
          umbrellaExecutor: umbrellaExecutor as unknown as OrchestratorAdapters['umbrellaExecutor'],
          escalate: async () => {},
          ...hermeticFilterAdapters(),
        },
        1,
      );

      // Two calls: first claude-cli (failed), then api-key (succeeded).
      expect(calls).toEqual(['claude-cli', 'api-key']);

      expect(tick.dispatched).toEqual([taskId]);
      const outcome = tick.outcomes[0];
      expect(outcome.outcome).toBe('approved');
      expect(outcome.failure).toBeUndefined();
      expect(outcome.pipeline).toBeDefined();
    });

    it('does NOT fall back when AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK is unset', async () => {
      delete process.env.AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK;
      const taskId = 'AISDLC-229-NOFALLBACK';
      const calls: Array<string> = [];

      const umbrellaExecutor = async (_t: string, kind: string): Promise<ExecuteCommandResult> => {
        calls.push(kind);
        return { ok: false, reason: 'claude-cli spawner failure' };
      };

      const tick = await runOrchestratorTick(
        config,
        {
          logger: silentLogger(),
          frontier: fakeFrontier([taskId]),
          umbrellaExecutor: umbrellaExecutor as unknown as OrchestratorAdapters['umbrellaExecutor'],
          escalate: async () => {},
          ...hermeticFilterAdapters(),
        },
        1,
      );

      // Only one call — no fallback attempted.
      expect(calls).toEqual(['claude-cli']);

      expect(tick.dispatched).toEqual([taskId]);
      const outcome = tick.outcomes[0];
      // Umbrella failed without fallback → failure recorded.
      expect(outcome.failure).toBeDefined();
    });

    it('does NOT fall back from explicit codex selection to api-key', async () => {
      process.env.AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK = 'api-key';
      const taskId = 'AISDLC-326-CODEX-NOFALLBACK';
      const calls: Array<string> = [];

      const umbrellaExecutor = async (_t: string, kind: string): Promise<ExecuteCommandResult> => {
        calls.push(kind);
        return {
          ok: false,
          reason: '`--spawner codex` requires CODEX_SPAWN_AGENT_BIN in the environment.',
        };
      };

      const tick = await runOrchestratorTick(
        config,
        {
          logger: silentLogger(),
          frontier: fakeFrontier([taskId]),
          umbrellaSpawnerKind: 'codex',
          umbrellaExecutor: umbrellaExecutor as unknown as OrchestratorAdapters['umbrellaExecutor'],
          escalate: async () => {},
          ...hermeticFilterAdapters(),
        },
        1,
      );

      expect(calls).toEqual(['codex']);
      const outcome = tick.outcomes[0];
      expect(outcome.failure?.type).toBe('spawner-unavailable');
      expect(outcome.failure?.message).toContain('CODEX_SPAWN_AGENT_BIN');
    });

    it('real codex spawner path fails before task mutation when CODEX_SPAWN_AGENT_BIN is unset', async () => {
      const previousBridge = process.env.CODEX_SPAWN_AGENT_BIN;
      delete process.env.CODEX_SPAWN_AGENT_BIN;
      process.env.AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK = 'api-key';
      const workDir = mkdtempSync(join(tmpdir(), 'aisdlc-326-codex-missing-'));
      const taskId = 'AISDLC-326-REAL-CODEX';

      try {
        const tick = await runOrchestratorTick(
          defaultOrchestratorConfig({ workDir, maxConcurrent: 1, maxTicks: 1 }),
          {
            logger: silentLogger(),
            frontier: fakeFrontier([taskId]),
            umbrellaSpawnerKind: 'codex',
            escalate: async () => {},
            ...hermeticFilterAdapters(),
          },
          1,
        );

        expect(tick.dispatched).toEqual([taskId]);
        const outcome = tick.outcomes[0];
        expect(outcome.failure?.type).toBe('spawner-unavailable');
        expect(outcome.failure?.message).toContain('CODEX_SPAWN_AGENT_BIN');
        expect(existsSync(join(workDir, '.worktrees'))).toBe(false);
        expect(existsSync(join(workDir, 'backlog'))).toBe(false);
      } finally {
        if (previousBridge === undefined) {
          delete process.env.CODEX_SPAWN_AGENT_BIN;
        } else {
          process.env.CODEX_SPAWN_AGENT_BIN = previousBridge;
        }
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });

  // ── AC #3: tick output schema unchanged ────────────────────────────────

  it('tick output schema still has dispatched/outcomes/escalations/idleEvent/filterEvents', async () => {
    const taskId = 'AISDLC-229-SCHEMA';

    const umbrellaDispatch = async (): Promise<RichDispatchResult> => ({
      result: pipelineResult(taskId, 'approved'),
      pipeline: {
        attestationSha: null,
        prNumber: 1,
        reviewerVerdicts: { code: 'approved', test: 'approved', security: 'approved' },
        iterations: 1,
      },
    });

    const tick = await runOrchestratorTick(
      config,
      {
        logger: silentLogger(),
        frontier: fakeFrontier([taskId]),
        umbrellaDispatch,
        escalate: async () => {},
        ...hermeticFilterAdapters(),
      },
      1,
    );

    // All pre-existing fields present (AC #3 — no schema breakage).
    expect(typeof tick.tick).toBe('number');
    expect(Array.isArray(tick.dispatched)).toBe(true);
    expect(Array.isArray(tick.outcomes)).toBe(true);
    expect(Array.isArray(tick.escalations)).toBe(true);
    expect(Array.isArray(tick.filterEvents)).toBe(true);
    expect(tick.idleEvent).toBeNull(); // dispatched → no idle event
    expect(typeof tick.nextSleepSec).toBe('number');
    expect(typeof tick.candidates).toBe('number');
    expect(typeof tick.empty).toBe('boolean');
  });
});
