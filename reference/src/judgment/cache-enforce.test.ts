import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeJudgmentProvider } from './fake-provider.js';
import { evaluateJudgment, type JudgmentEvaluationRecord } from './evaluate.js';
import { resolveJudgmentConfig } from './config.js';
import type { JudgmentDefinition } from './definition.js';
import type { JudgmentAnswer } from './types.js';
import { createJudgmentCache, judgmentCacheKey } from './cache.js';
import { createJudgmentLogSink, judgmentLogLine, judgmentLogPath } from './log-sink.js';
import { readJudgmentLog } from './log-reader.js';
import { canonicalJson, sha256Hex } from './question-hash.js';

const PROVIDER_ANSWER: JudgmentAnswer = { type: 'noul', probability: 0.95 };
const PLANTED_ANSWER: JudgmentAnswer = { type: 'noul', probability: 0.05 };
const QUESTIONS = { q1: { type: 'noul' as const, instructions: 'Is it fine?' } };

const def = {
  id: 'test.judgment',
  version: 1,
  egressClass: 'work-item-text',
  direction: 'tighten-only',
  riskClass: 'seam',
  fallback: 'pending',
  buildState: (i: { text: string }) => ({ text: i.text }),
  questions: () => QUESTIONS,
  compose: (answers: Record<string, JudgmentAnswer>) => ({
    kind: 'act',
    decision: { p: (answers.q1 as { probability: number }).probability },
  }),
} as unknown as JudgmentDefinition<{ text: string }, { p: number }>;

const enforced = (cache = true) =>
  resolveJudgmentConfig({
    spec: {
      provider: 'fake',
      model: 'fake-1',
      defaults: { mode: 'shadow', cache },
      judgments: {
        'test.judgment': {
          mode: 'enforce',
          thresholds: { 'fake@fake-1': { pass: 0.8 } },
          promotion: { 'fake@fake-1': { path: 'override', evidence: 'looked at 20 items' } },
        },
      },
    },
  });
const shadowCfg = () =>
  resolveJudgmentConfig({
    spec: { provider: 'fake', model: 'fake-1', defaults: { mode: 'shadow', cache: true } },
  });
// enforce configured but downgraded to shadow (no thresholds / promotion)
const downgradedCfg = () =>
  resolveJudgmentConfig({
    spec: {
      provider: 'fake',
      model: 'fake-1',
      defaults: { mode: 'shadow', cache: true },
      judgments: { 'test.judgment': { mode: 'enforce' } },
    },
  });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'judgment-cache-enforce-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function plant(answer: JudgmentAnswer, text = 'a') {
  const questionSetHash = sha256Hex(canonicalJson({ questions: QUESTIONS, version: 1 }));
  const stateHash = sha256Hex(canonicalJson({ text }));
  const key = judgmentCacheKey({
    provider: 'fake',
    model: 'fake-1',
    questionSetHash,
    questions: QUESTIONS,
    stateHash,
  });
  createJudgmentCache(dir).put(key, { modelVersion: 'fake-1', answers: { q1: answer } });
  return key;
}

async function run(config: ReturnType<typeof enforced>) {
  const provider = new FakeJudgmentProvider({ modelId: 'fake-1' }).script('q1', PROVIDER_ANSWER);
  const records: JudgmentEvaluationRecord[] = [];
  const outcome = await evaluateJudgment(
    def,
    { text: 'a' },
    {
      config,
      getProvider: () => provider,
      cache: createJudgmentCache(dir),
      sinks: [{ record: (r) => void records.push(r) }],
    },
  );
  return { outcome, provider, rec: records[0] };
}

describe('enforce mode never reads the judgment cache', () => {
  it('ignores a planted entry: provider called, its answer used, record shows the reason', async () => {
    plant(PLANTED_ANSWER);
    const { outcome, provider, rec } = await run(enforced());
    expect(provider.requests).toHaveLength(1);
    expect(outcome).toEqual({ kind: 'act', decision: { p: 0.95 } });
    expect(rec.mode).toBe('enforce');
    expect(rec.cacheHit).toBe(false);
    expect(rec.cacheMissReason).toBe('enforce');
  });

  it('serves the same planted entry on a shadow evaluation', async () => {
    plant(PLANTED_ANSWER);
    const { provider, rec } = await run(shadowCfg());
    expect(provider.requests).toHaveLength(0);
    expect(rec.cacheHit).toBe(true);
    expect(rec.cacheMissReason).toBeUndefined();
  });

  it('still reads the cache when enforce is configured but downgraded to shadow', async () => {
    plant(PLANTED_ANSWER);
    const { provider, rec } = await run(downgradedCfg());
    expect(rec.mode).toBe('shadow');
    expect(rec.configuredMode).toBe('enforce');
    expect(provider.requests).toHaveLength(0);
    expect(rec.cacheHit).toBe(true);
  });

  it('still writes the cache in enforce mode', async () => {
    const { rec } = await run(enforced());
    expect(rec.cacheHit).toBe(false);
    const cdir = join(dir, '_judgment', 'cache');
    expect(existsSync(cdir)).toBe(true);
    expect(readdirSync(cdir).length).toBe(1);
    // a following shadow evaluation is served from that write
    const second = await run(shadowCfg());
    expect(second.rec.cacheHit).toBe(true);
    expect(second.provider.requests).toHaveLength(0);
  });

  it('fails closed: an off-enum mode never reads the cache', async () => {
    plant(PLANTED_ANSWER);
    const base = shadowCfg();
    const odd = { ...base, defaults: { ...base.defaults, mode: 'Enforce' as never } };
    const { provider, rec } = await run(odd);
    expect(provider.requests).toHaveLength(1);
    expect(rec.cacheHit).toBe(false);
  });

  it('records no reason when the cache is off', async () => {
    const { rec } = await run(enforced(false));
    expect(rec.cacheMissReason).toBeUndefined();
  });
});

describe('cacheMissReason log round-trip', () => {
  const base: JudgmentEvaluationRecord = {
    ts: '2026-10-01T00:00:00.000Z',
    judgmentId: 'test.judgment',
    version: 1,
    consumerLabel: 'x',
    questionSetHash: null,
    stateHash: null,
    provider: 'fake',
    providerModelKey: null,
    modelVersion: null,
    mode: 'enforce',
    answers: null,
    thresholds: null,
    outcome: { kind: 'abstain', reason: 'x' },
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    called: true,
    costUsd: null,
    cacheHit: false,
  };

  it('survives sink -> reader, and old lines without the field parse to null', () => {
    const sink = createJudgmentLogSink({ artifactsDir: dir });
    void sink.record({ ...base, cacheMissReason: 'enforce' });
    const line = JSON.parse(judgmentLogLine(base)) as Record<string, unknown>;
    delete line.cacheMissReason;
    appendFileSync(judgmentLogPath(dir, new Date(base.ts)), `${JSON.stringify(line)}\n`);
    const { entries } = readJudgmentLog(dir);
    expect(entries).toHaveLength(2);
    expect(entries[0].cacheMissReason).toBe('enforce');
    expect(entries[1].cacheMissReason).toBeNull();
  });
});
