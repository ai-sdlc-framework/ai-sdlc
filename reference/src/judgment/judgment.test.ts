import { describe, expect, it } from 'vitest';
import {
  FakeJudgmentProvider,
  JudgmentProviderError,
  UnknownJudgmentProviderError,
  getJudgmentProvider,
  listJudgmentProviders,
  registerJudgmentProvider,
} from './index.js';
import type { JudgmentRequest } from './index.js';

const req: JudgmentRequest = {
  state: 's',
  consumerLabel: 'test',
  questions: {
    a: { type: 'noul', instructions: 'i' },
    b: { type: 'score', instructions: 'i', levels: ['x', 'y'] },
  },
};

describe('registry', () => {
  it('registers, lists, resolves and rejects unknown names', () => {
    const p = new FakeJudgmentProvider({ name: 'reg-test' });
    registerJudgmentProvider(p);
    expect(getJudgmentProvider('reg-test')).toBe(p);
    expect(listJudgmentProviders()).toContain('reg-test');
    expect(() => getJudgmentProvider('nope')).toThrow(UnknownJudgmentProviderError);
    try {
      getJudgmentProvider('nope');
    } catch (e) {
      expect((e as UnknownJudgmentProviderError).message).toContain('reg-test');
    }
  });

  it('reports none registered when empty-named lookups fail with a readable message', () => {
    expect(new UnknownJudgmentProviderError('x', []).message).toContain('(none)');
  });
});

describe('FakeJudgmentProvider', () => {
  it('returns scripted values and function answers, recording requests', async () => {
    const p = new FakeJudgmentProvider({ capabilities: { maxScoreLevels: 4 } });
    p.script('a', { type: 'noul', probability: 0.3 }).script('b', (r) => ({
      type: 'score',
      score: Object.keys(r.questions).length,
      probabilities: [0.5, 0.5],
      confidence: 1,
    }));
    const res = await p.evaluate(req);
    expect(res.answers.a).toEqual({ type: 'noul', probability: 0.3 });
    expect(res.answers.b).toMatchObject({ type: 'score', score: 2 });
    expect(res.modelVersion).toBe('fake-1');
    expect(p.requests).toEqual([req]);
    expect(p.capabilities.maxScoreLevels).toBe(4);
    expect(await p.isAvailable()).toEqual({ available: true });
    expect(await p.getAccountId()).toBe('fake-account');
  });

  it('throws a chosen error kind and can clear it', async () => {
    const p = new FakeJudgmentProvider().failWith('rate-limited');
    await expect(p.evaluate(req)).rejects.toMatchObject({ kind: 'rate-limited' });
    expect(p.requests).toHaveLength(1);
    p.failWith(undefined);
    await expect(p.evaluate(req)).rejects.toBeInstanceOf(JudgmentProviderError);
  });

  it('fails with bad-response when a question has no script', async () => {
    await expect(new FakeJudgmentProvider().evaluate(req)).rejects.toMatchObject({
      kind: 'bad-response',
    });
  });

  it('can be unavailable', async () => {
    const p = new FakeJudgmentProvider({ available: false });
    expect((await p.isAvailable()).available).toBe(false);
    expect(await p.getAccountId()).toBeNull();
  });
});
