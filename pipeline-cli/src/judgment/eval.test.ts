import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeJudgmentProvider,
  canonicalJson,
  createJudgmentCache,
  judgmentCacheKey,
  resolveJudgmentConfig,
  sha256Hex,
  type JudgmentAnswer,
  type JudgmentDefinition,
} from '@ai-sdlc/reference';
import { collectAnswers, evaluateOnce } from './eval.js';

const QUESTIONS = { q1: { type: 'noul' as const, instructions: 'Is it fine?' } };
const PLANTED: JudgmentAnswer = { type: 'noul', probability: 0.05 };
const def = {
  id: 'eval.test',
  version: 1,
  egressClass: 'work-item-text',
  direction: 'tighten-only',
  riskClass: 'seam',
  fallback: 'pending',
  buildState: (i: { text: string }) => ({ text: i.text }),
  questions: () => QUESTIONS,
  compose: () => ({ kind: 'act', decision: true }),
} as unknown as JudgmentDefinition<{ text: string }, boolean>;

// Configured enforce, fully promoted: replay must still force shadow and read the cache.
const config = resolveJudgmentConfig({
  spec: {
    provider: 'fake',
    model: 'fake-1',
    defaults: { mode: 'shadow' },
    judgments: {
      'eval.test': {
        mode: 'enforce',
        thresholds: { 'fake@fake-1': { pass: 0.8 } },
        promotion: { 'fake@fake-1': { path: 'override', evidence: 'looked at 20 items' } },
      },
    },
  },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'judgment-eval-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function plant() {
  const key = judgmentCacheKey({
    provider: 'fake',
    model: 'fake-1',
    questionSetHash: sha256Hex(canonicalJson({ questions: QUESTIONS, version: 1 })),
    questions: QUESTIONS,
    stateHash: sha256Hex(canonicalJson({ text: 'a' })),
  });
  createJudgmentCache(dir).put(key, { modelVersion: 'fake-1', answers: { q1: PLANTED } });
}
const provider = () =>
  new FakeJudgmentProvider({ modelId: 'fake-1' }).script('q1', { type: 'noul', probability: 0.95 });

describe('replay path serves a planted cache entry for an enforce-configured judgment', () => {
  it('evaluateOnce: cache hit, no provider call, shadow mode, no miss reason', async () => {
    plant();
    const p = provider();
    const rec = await evaluateOnce(
      def,
      { text: 'a' },
      {
        config,
        getProvider: () => p,
        cache: createJudgmentCache(dir),
        sourceKind: 'backlog',
      },
    );
    expect(rec.cacheHit).toBe(true);
    expect(p.requests).toHaveLength(0);
    expect(rec.mode).toBe('shadow');
    expect(rec.cacheMissReason).toBeUndefined();
    expect(rec.answers).toEqual({ q1: PLANTED });
  });

  it('collectAnswers over a one-item corpus reports the cache hit', async () => {
    plant();
    const p = provider();
    const items = await collectAnswers(def, [{ input: { text: 'a' } } as never], {
      config,
      getProvider: () => p,
      cache: createJudgmentCache(dir),
      sourceKind: 'backlog',
    });
    expect(items).toHaveLength(1);
    expect(items[0].cacheHit).toBe(true);
    expect(items[0].called).toBe(false);
    expect(p.requests).toHaveLength(0);
  });
});
