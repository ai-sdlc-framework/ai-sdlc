import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { JudgmentEvaluationRecord } from '@ai-sdlc/reference';
import { StateStore } from './state/store.js';
import { CostTracker } from './cost-tracker.js';
import { createJudgmentCostSink } from './judgment-cost-sink.js';

function rec(over: Partial<JudgmentEvaluationRecord> = {}): JudgmentEvaluationRecord {
  return {
    ts: '2026-10-01T00:00:00Z',
    judgmentId: 'dor.stage-b',
    version: 1,
    consumerLabel: 'dor.stage-b',
    questionSetHash: 'q',
    stateHash: 's',
    provider: 'jev',
    providerModelKey: 'jev@jev-1.13.0',
    modelVersion: 'jev-1.13.0',
    mode: 'shadow',
    answers: null,
    thresholds: null,
    outcome: { kind: 'abstain', reason: 'shadow' },
    latencyMs: 5,
    inputTokens: 1000,
    outputTokens: 0,
    called: true,
    costUsd: 0.000042,
    cacheHit: false,
    ...over,
  };
}

describe('createJudgmentCostSink', () => {
  let store: StateStore;
  let sink: ReturnType<typeof createJudgmentCostSink>;
  const rows = () => store.getCostEntries({}).filter((e) => e.pipelineType === 'judgmentTokens');

  beforeEach(() => {
    store = StateStore.open(new Database(':memory:'));
    sink = createJudgmentCostSink(new CostTracker(store), 'run-1');
  });

  it('writes one row per uncached call', async () => {
    await sink.record(rec());
    expect(rows()).toHaveLength(1);
    expect(rows()[0].costUsd).toBeCloseTo(0.000042, 9);
    expect(rows()[0].runId).toBe('run-1');
  });

  it('falls back to the priced row when the record has no cost', async () => {
    await sink.record(rec({ costUsd: null }));
    expect(rows()[0].costUsd).toBeCloseTo(0.000042, 9);
  });

  it('writes nothing for cache hits, no-call, or incomplete records', async () => {
    await sink.record(rec({ cacheHit: true }));
    await sink.record(rec({ called: false }));
    await sink.record(rec({ provider: null }));
    await sink.record(rec({ modelVersion: null }));
    await sink.record(rec({ inputTokens: null }));
    expect(rows()).toHaveLength(0);
  });
});
