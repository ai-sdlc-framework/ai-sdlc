/**
 * failure.class wiring in the tick loop: the advisory label is attached beside the
 * unchanged outcome, only for failures the playbook left unmatched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeJudgmentProvider,
  disabledJudgmentConfig,
  resolveJudgmentConfig,
  type EvaluateJudgmentContext,
} from '@ai-sdlc/reference';
import {
  defaultOrchestratorConfig,
  runOrchestratorTick,
  type OrchestratorAdapters,
} from './index.js';
import { FAILURE_CLASS_ID } from '../judgment/failure-class.js';

let artifactsDir: string;
beforeEach(() => {
  artifactsDir = mkdtempSync(join(tmpdir(), 'aisdlc-loop-fc-'));
});
afterEach(() => {
  rmSync(artifactsDir, { recursive: true, force: true });
});

function adapters(judgment: EvaluateJudgmentContext): OrchestratorAdapters {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {}, progress: () => {} },
    frontier: () => [{ id: 'AISDLC-FC', title: 'Task' }],
    dispatch: async () => {
      throw new Error('something odd happened with zebra');
    },
    escalate: async () => {},
    graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
    taskLabelsLoader: () => [],
    calibrationLogPath: '/nonexistent-phase1-tests-bypass.jsonl',
    alreadyInFlightOpts: { detectSubprocess: false, listOpenPRs: () => [] },
    openPRExistsOpts: { listOpenPRsByBranch: () => [] },
    parentBranchGuard: async () => {},
    artifactsDir,
    judgment,
  };
}

function enabledCtx(): EvaluateJudgmentContext {
  const fake = new FakeJudgmentProvider().script('class', {
    type: 'choice',
    choice: 'external-dependency-failed',
    probabilities: { 'external-dependency-failed': 0.95 },
    confidence: 0.9,
  });
  return {
    config: resolveJudgmentConfig({
      spec: {
        provider: 'fake',
        model: 'fake-1',
        egress: { allow: ['work-item-text', 'agent-output'] },
        judgments: {
          [FAILURE_CLASS_ID]: {
            mode: 'enforce',
            thresholds: { 'fake@fake-1': { label: 0.8 } },
            promotion: { 'fake@fake-1': { path: 'override', evidence: 'reviewed' } },
          },
        },
      },
    }),
    getProvider: () => fake,
  };
}

async function tick(judgment: EvaluateJudgmentContext) {
  const config = defaultOrchestratorConfig({ workDir: '/tmp', maxConcurrent: 1, maxTicks: 1 });
  return runOrchestratorTick(config, adapters(judgment), 1);
}

describe('failure.class in the orchestrator loop', () => {
  it('leaves the outcome identical when the layer is disabled', async () => {
    const result = await tick({ config: disabledJudgmentConfig() });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].outcome).toBe('unknown-failure');
    expect(result.outcomes[0]).not.toHaveProperty('advisoryFailureClass');
  });

  it('attaches the advisory label beside the unchanged primary outcome when enabled', async () => {
    const result = await tick(enabledCtx());
    expect(result.outcomes[0].outcome).toBe('unknown-failure');
    expect(result.outcomes[0].error).toContain('zebra');
    expect(result.outcomes[0].advisoryFailureClass).toBe('external-dependency-failed');
    expect(result.escalations[0].event).toBe('UnknownFailureMode');
  });
});
