/**
 * Loop ↔ playbook integration tests (RFC-0015 Phase 2 / AISDLC-169.2).
 *
 * Cover the wiring between `runOrchestratorTick` and the new failure
 * playbook:
 *
 *   1. A dispatch failure that matches a catalogued handler is REMEDIATED
 *      by the playbook; the tick records the remediated outcome instead
 *      of falling through to UnknownFailureMode.
 *   2. A dispatch failure that does NOT match the catalogue still falls
 *      through to the Phase 1 UnknownFailureMode escalation (backward
 *      compat with AISDLC-169.1's behaviour).
 *   3. Playbook events surface on the tick result for Phase 4 consumers.
 *   4. Catalogue is overrideable via OrchestratorAdapters.catalogue —
 *      operator config wins over defaults.
 */

import { describe, expect, it } from 'vitest';

import {
  defaultOrchestratorConfig,
  runOrchestratorTick,
  type OrchestratorAdapters,
} from './index.js';
import { DEFAULT_CATALOGUE, type FailurePatternCatalogue } from './playbook/index.js';
import type { PipelineLogger, PipelineResult } from '../types.js';

function silentLogger(): PipelineLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, progress: () => {} };
}

function approvedResult(taskId: string): PipelineResult {
  return {
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktreePath: `/tmp/${taskId.toLowerCase()}`,
    outcome: 'approved',
    prUrl: `https://example.com/pr/${taskId}`,
    siblingPrUrls: [],
    iterations: 2,
    finalVerdict: null,
  };
}

describe('runOrchestratorTick — playbook integration', () => {
  it('routes a verification failure through the playbook and reports recovered outcome', async () => {
    let dispatches = 0;
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: async () => {},
      frontier: () => [{ id: 'AISDLC-VF', title: 'verify-fail' }],
      // First dispatch throws a verify-tool stderr; the playbook's
      // `redispatch` then re-runs and approves on the second try.
      dispatch: async (taskId): Promise<PipelineResult> => {
        dispatches += 1;
        if (dispatches === 1) {
          const err = new Error('pnpm test failed at exit 1');
          throw err;
        }
        return approvedResult(taskId);
      },
      catalogue: forceBudget(DEFAULT_CATALOGUE, 'VerificationFailure', 1),
      escalate: async () => {},
    };
    const config = defaultOrchestratorConfig({ workDir: '/tmp', maxConcurrent: 1 });
    const result = await runOrchestratorTick(config, adapters, 1);

    expect(result.outcomes).toHaveLength(1);
    // The first dispatch threw — but the playbook's redispatch hook
    // recovered with an approved result; `dispatch` was called twice.
    expect(dispatches).toBe(2);
    expect(result.outcomes[0]!.outcome).toBe('approved');
    // No escalation should have been recorded — the playbook handled it.
    expect(result.escalations).toHaveLength(0);
    // Playbook events surfaced for Phase 4 consumers.
    expect(result.playbookEvents?.length ?? 0).toBeGreaterThan(0);
    expect(result.playbookEvents?.some((e) => e.event === 'WorkerStateTransition')).toBe(true);
    expect(result.playbookEvents?.some((e) => e.event === 'RemediationApplied')).toBe(true);
  });

  it('routes a verification failure through escalation when budget is 0 (operator override)', async () => {
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: async () => {},
      frontier: () => [{ id: 'AISDLC-VF', title: 'verify-fail' }],
      dispatch: async () => {
        throw new Error('pnpm test failed at exit 1');
      },
      // Force budget=0 so the playbook escalates immediately.
      catalogue: forceBudget(DEFAULT_CATALOGUE, 'VerificationFailure', 0),
      escalate: async () => {},
    };
    const config = defaultOrchestratorConfig({ workDir: '/tmp', maxConcurrent: 1 });
    const result = await runOrchestratorTick(config, adapters, 1);

    expect(result.escalations).toHaveLength(1);
    expect(result.escalations[0]!.event).toBe('VerificationFailure');
    expect(result.outcomes[0]!.outcome).toBe('unknown-failure');
    expect(result.outcomes[0]!.notes).toContain('VerificationFailure');
  });

  it('falls through to UnknownFailureMode when no catalogued handler matches', async () => {
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: async () => {},
      frontier: () => [{ id: 'AISDLC-NOVEL', title: 'novel' }],
      dispatch: async () => {
        // No verify-tool keyword, no secret-scan phrase, no merge-queue
        // phrase — nothing the catalogue can match.
        throw new Error('completely novel failure shape');
      },
      catalogue: DEFAULT_CATALOGUE,
      escalate: async () => {},
    };
    const config = defaultOrchestratorConfig({ workDir: '/tmp', maxConcurrent: 1 });
    const result = await runOrchestratorTick(config, adapters, 1);

    expect(result.escalations).toHaveLength(1);
    expect(result.escalations[0]!.event).toBe('UnknownFailureMode');
  });

  it('still escalates the executePipeline native needs-human-attention outcome (Phase 1 compat)', async () => {
    let labelled = false;
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      sleep: async () => {},
      frontier: () => [{ id: 'AISDLC-NHA', title: 'nha' }],
      dispatch: async (taskId): Promise<PipelineResult> => ({
        taskId,
        branch: `ai-sdlc/${taskId.toLowerCase()}`,
        worktreePath: '/tmp',
        outcome: 'needs-human-attention',
        prUrl: 'https://example.com/pr/NHA',
        siblingPrUrls: [],
        iterations: 2,
        finalVerdict: null,
        notes: 'iteration cap exceeded',
      }),
      escalate: async () => {
        labelled = true;
      },
      catalogue: DEFAULT_CATALOGUE,
    };
    const config = defaultOrchestratorConfig({ workDir: '/tmp', maxConcurrent: 1 });
    const result = await runOrchestratorTick(config, adapters, 1);
    expect(result.escalations).toHaveLength(1);
    expect(result.outcomes[0]!.outcome).toBe('needs-human-attention');
    expect(labelled).toBe(true);
  });
});

function forceBudget(
  c: FailurePatternCatalogue,
  mode: string,
  budget: number,
): FailurePatternCatalogue {
  return {
    ...c,
    patterns: c.patterns.map((p) => (p.mode === mode ? { ...p, budget } : p)),
  };
}
