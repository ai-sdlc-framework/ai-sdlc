import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  FakeJudgmentProvider,
  disabledJudgmentConfig,
  evaluateJudgment,
  resolveJudgmentConfig,
  type JudgmentDefinition,
} from '@ai-sdlc/reference';
import { StateStore } from './state/store.js';
import { CostTracker } from './cost-tracker.js';
import { buildOrchestratorJudgmentContext } from './judgment-context.js';

const def = {
  id: 'ctx.test',
  version: 1,
  egressClass: 'work-item-text',
  direction: 'tighten-only',
  riskClass: 'tighten',
  buildState: () => ({ t: 'x' }),
  questions: () => ({ q1: { type: 'noul', instructions: 'ok?' } }),
  compose: () => ({ kind: 'act', decision: true }),
} as JudgmentDefinition<unknown, boolean>;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-judgment-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildOrchestratorJudgmentContext', () => {
  it('abstains cleanly with the layer disabled and has no sinks', async () => {
    const ctx = buildOrchestratorJudgmentContext({
      config: disabledJudgmentConfig(),
      artifactsDir: dir,
    });
    expect(ctx.sinks).toBeUndefined();
    expect(await evaluateJudgment(def, {}, ctx)).toEqual({ kind: 'abstain', reason: 'disabled' });
  });

  it('is disabled when AI_SDLC_JUDGMENT=off, and never throws on a broken loader', () => {
    const off = buildOrchestratorJudgmentContext({ env: { AI_SDLC_JUDGMENT: 'off' } });
    expect(off.config.provider).toBeUndefined();
    const broken = buildOrchestratorJudgmentContext({
      loader: {
        readBaseConfig: () => {
          throw new Error('boom');
        },
      },
    });
    expect(broken.config.provider).toBeUndefined();
  });

  it('writes one cost_ledger row for an uncached evaluation, none for a cache hit', async () => {
    const store = StateStore.open(new Database(':memory:'));
    const tracker = new CostTracker(store);
    const fake = new FakeJudgmentProvider({
      name: 'fake',
      modelId: 'fake-1',
    });
    fake.script('q1', { type: 'noul', probability: 0.9 });
    const origEvaluate = fake.evaluate.bind(fake);
    fake.evaluate = async (req) => {
      const r = await origEvaluate(req);
      return { ...r, usage: { inputTokens: 500, outputTokens: 0 } };
    };
    const config = resolveJudgmentConfig({
      spec: { provider: 'fake', model: 'fake-1', defaults: { cache: true, mode: 'shadow' } },
    });
    const ctx = {
      ...buildOrchestratorJudgmentContext({
        config,
        artifactsDir: dir,
        costTracker: tracker,
        runId: 'r1',
      }),
      getProvider: () => fake,
    };
    expect(ctx.sinks).toHaveLength(2);
    expect(ctx.cache).toBeDefined();
    await evaluateJudgment(def, {}, ctx);
    const rows = () => store.getCostEntries({}).filter((e) => e.pipelineType === 'judgmentTokens');
    expect(rows()).toHaveLength(1);
    await evaluateJudgment(def, {}, ctx);
    expect(rows()).toHaveLength(1);
  });

  it('carries per-call fields and extra sinks', () => {
    const extra = { record: () => undefined };
    const ctx = buildOrchestratorJudgmentContext({
      config: resolveJudgmentConfig({ spec: { provider: 'fake', model: 'fake-1' } }),
      artifactsDir: dir,
      sinks: [extra],
      sourceKind: 'issue',
      taskId: 'T-1',
      consumerLabel: 'x',
      now: () => new Date(0),
      fetchImpl: (async () => new Response('{}')) as typeof fetch,
    });
    expect(ctx.sinks).toContain(extra);
    expect(ctx.sourceKind).toBe('issue');
    expect(ctx.taskId).toBe('T-1');
    expect(ctx.consumerLabel).toBe('x');
  });
});
