import { describe, expect, it } from 'vitest';
import { getJudgmentDefinition, registerJudgmentDefinition } from '../catalog.js';
import { evaluateJudgment } from '../evaluate.js';
import { FakeJudgmentProvider } from '../fake-provider.js';
import type { ResolvedJudgmentConfig } from '../config.js';
import type { JudgmentAnswer } from '../types.js';
import { registerReviewJudgmentDefinitions } from './review-judgments.js';
import { reviewRoutingDefinition } from './review-routing.js';
import { REVIEWER_SET_SIGNAL_IDS, reviewerSetDefinition } from './review-reviewer-set.js';

const noul = (probability: number): JudgmentAnswer => ({ type: 'noul', probability });
const KEY = 'fake@fake-1';

const input = { changedFiles: ['src/a.ts'], diff: 'diff --git a/src/a.ts b/src/a.ts\n+x\n' };

function config(
  id: string,
  mode: 'shadow' | 'enforce',
  promotion?: ResolvedJudgmentConfig['judgments'][string]['promotion'][string],
  thresholds: Record<string, number> = {},
): ResolvedJudgmentConfig {
  return {
    provider: 'fake',
    model: 'fake-1',
    providerOptions: {},
    egressAllow: ['code-diff'],
    defaults: { mode: 'shadow', timeoutMs: 1000, cache: false },
    judgments: {
      [id]: {
        mode,
        thresholds: { [KEY]: thresholds },
        promotion: promotion ? { [KEY]: promotion } : {},
      },
    },
  };
}

function providerWith(ids: readonly string[], p: number): FakeJudgmentProvider {
  const fake = new FakeJudgmentProvider();
  for (const id of ids) fake.script(id, noul(p));
  return fake;
}

const SET_THRESHOLDS = Object.fromEntries(REVIEWER_SET_SIGNAL_IDS.map((id) => [id, 0.3]));
const ALL_ROUTING = ['auth-session-secrets', 'input-handling', 'dependencies-ci'];

describe('review judgment registration', () => {
  it('registers both definitions (idempotently) with the declared classes', () => {
    registerReviewJudgmentDefinitions();
    registerReviewJudgmentDefinitions();
    expect(getJudgmentDefinition('review.routing')).toMatchObject({
      riskClass: 'tighten',
      direction: 'tighten-only',
      egressClass: 'code-diff',
    });
    const set = getJudgmentDefinition('review.reviewer-set');
    expect(set).toMatchObject({
      riskClass: 'relax',
      direction: 'bidirectional',
      reducesReview: true,
      reducingOutcomes: ['code-test-merged'],
    });
  });

  it('rejects a reviewer-set declaration with reducesReview omitted', () => {
    const { reducesReview: _omit, ...mutated } = reviewerSetDefinition;
    expect(() =>
      registerJudgmentDefinition({ ...mutated, id: 'review.reviewer-set.mutated' }),
    ).toThrow(/rule \(d\)|rule \(c\)/);
    expect(getJudgmentDefinition('review.reviewer-set.mutated')).toBeUndefined();
  });

  it('rejects reviewer-set declared as seam', () => {
    expect(() =>
      registerJudgmentDefinition({
        ...reviewerSetDefinition,
        id: 'review.reviewer-set.seam',
        riskClass: 'seam',
        fallback: 'pending',
      }),
    ).toThrow(/rule/);
  });

  it('evaluateJudgment abstains when a definition is mutated to break the rules', async () => {
    const { reducesReview: _omit, ...mutated } = reviewerSetDefinition;
    const out = await evaluateJudgment(mutated as typeof reviewerSetDefinition, input, {
      config: config('review.reviewer-set', 'enforce'),
      getProvider: () => providerWith(REVIEWER_SET_SIGNAL_IDS, 0),
    });
    expect(out).toEqual({ kind: 'abstain', reason: 'definition-error' });
  });
});

describe('review.routing compose', () => {
  const compose = (answers: Record<string, number>, regex: string[], th = {}) =>
    reviewRoutingDefinition.compose(
      Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, noul(v)])),
      { ...input, regexReviewers: regex as never },
      th,
      { permissiveAllowed: false },
    );

  it('adds the security reviewer when a signal clears the threshold', () => {
    const out = compose(
      { 'auth-session-secrets': 0.1, 'input-handling': 0.9, 'dependencies-ci': 0 },
      ['critic'],
    );
    expect(out).toEqual({
      kind: 'act',
      decision: {
        reviewers: ['testing', 'critic', 'security'],
        added: ['testing', 'security'],
        called: ['testing', 'security'],
        signals: ['input-handling'],
      },
    });
  });

  it('never returns fewer reviewers than the path decision', () => {
    const out = compose({ 'dependencies-ci': 0.99 }, ['testing', 'critic', 'security']);
    expect(out.kind === 'act' && out.decision.reviewers).toEqual(['testing', 'critic', 'security']);
    expect(out.kind === 'act' && out.decision.added).toEqual([]);
  });

  it('abstains with no signal and honours configured thresholds', () => {
    expect(compose({ 'input-handling': 0.4 }, []).kind).toBe('abstain');
    expect(compose({ 'input-handling': 0.4 }, [], { 'input-handling': 0.3 }).kind).toBe('act');
    expect(compose({ 'input-handling': 0.4 }, [], { 'input-handling': 0.5 }).kind).toBe('abstain');
  });

  it('ignores a missing or mistyped answer and tolerates missing input', () => {
    const out = reviewRoutingDefinition.compose(
      {
        'input-handling': { type: 'score', score: 0, probabilities: [1], confidence: 1 },
        'auth-session-secrets': noul(0.8),
      },
      undefined as never,
      {},
      { permissiveAllowed: false },
    );
    expect(out.kind === 'act' && out.decision.signals).toEqual(['auth-session-secrets']);
  });

  it('builds a state and questions without truncation', () => {
    expect(reviewRoutingDefinition.buildState({ ...input, regexReviewers: [] })).toEqual(input);
    expect(Object.keys(reviewRoutingDefinition.questions({} as never))).toEqual(ALL_ROUTING);
  });
});

describe('review.reviewer-set compose', () => {
  const answers = (p: number, over: Record<string, number> = {}) =>
    Object.fromEntries(REVIEWER_SET_SIGNAL_IDS.map((id) => [id, noul(over[id] ?? p)]));
  const run = (a: Record<string, JudgmentAnswer>, th: Record<string, number>, permissive = true) =>
    reviewerSetDefinition.compose(a, input, th, { permissiveAllowed: permissive });

  it('acts with the merged set only when every signal is below its threshold', () => {
    const out = run(answers(0.05), SET_THRESHOLDS);
    expect(out.kind === 'act' && out.decision.set).toBe('code-test-merged');
  });

  it('abstains when any single signal is at or above its threshold', () => {
    for (const id of REVIEWER_SET_SIGNAL_IDS) {
      const out = run(answers(0.05, { [id]: 0.3 }), SET_THRESHOLDS);
      expect(out).toEqual({ kind: 'abstain', reason: `signal-raised:${id}` });
    }
  });

  it('abstains when permissive decisions are not allowed', () => {
    expect(run(answers(0), SET_THRESHOLDS, false).kind).toBe('abstain');
  });

  it('abstains when a threshold or answer is missing', () => {
    expect(run(answers(0), {}).kind).toBe('abstain');
    const partial = answers(0);
    delete partial['multi-package'];
    expect(run(partial, SET_THRESHOLDS)).toMatchObject({ kind: 'abstain' });
  });

  it('agrees reads the label conservatively', () => {
    const d = { set: 'code-test-merged' as const, signals: {} };
    expect(reviewerSetDefinition.agrees?.(d, { separateReviewBlocking: false })).toBe(true);
    expect(reviewerSetDefinition.agrees?.(d, { separateReviewBlocking: true })).toBe(false);
    expect(reviewerSetDefinition.agrees?.(d, 'garbage')).toBe(false);
    expect(reviewerSetDefinition.agrees?.(d, null)).toBe(false);
  });
});

describe('promotion bar through evaluateJudgment', () => {
  const run = (cfg: ResolvedJudgmentConfig, p = 0) =>
    evaluateJudgment(reviewerSetDefinition, input, {
      config: cfg,
      getProvider: () => providerWith(REVIEWER_SET_SIGNAL_IDS, p),
      sourceKind: 'backlog',
    });

  it('a corpus record (n>=50, precision>=0.95) enforces and acts', async () => {
    const cfg = config(
      'review.reviewer-set',
      'enforce',
      { path: 'corpus', n: 50, actBandPrecision: 0.95 },
      SET_THRESHOLDS,
    );
    expect((await run(cfg)).kind).toBe('act');
  });

  it('a path: override record stays in shadow', async () => {
    const records: unknown[] = [];
    const cfg = config(
      'review.reviewer-set',
      'enforce',
      { path: 'override', evidence: 'looked at it' },
      SET_THRESHOLDS,
    );
    const out = await evaluateJudgment(reviewerSetDefinition, input, {
      config: cfg,
      getProvider: () => providerWith(REVIEWER_SET_SIGNAL_IDS, 0),
      sourceKind: 'backlog',
      sinks: [{ record: (r) => void records.push(r) }],
    });
    expect(out).toEqual({ kind: 'abstain', reason: 'shadow' });
    expect(records[0]).toMatchObject({ mode: 'shadow', downgradeReason: 'no-promotion' });
  });

  it('a weak corpus record stays in shadow', async () => {
    const cfg = config(
      'review.reviewer-set',
      'enforce',
      { path: 'corpus', n: 49, actBandPrecision: 0.99 },
      SET_THRESHOLDS,
    );
    expect(await run(cfg)).toEqual({ kind: 'abstain', reason: 'shadow' });
  });

  it('a gh-issue source never gets the merged set, whatever the answers', async () => {
    const cfg = config(
      'review.reviewer-set',
      'enforce',
      { path: 'corpus', n: 80, actBandPrecision: 0.99 },
      SET_THRESHOLDS,
    );
    const out = await evaluateJudgment(reviewerSetDefinition, input, {
      config: cfg,
      getProvider: () => providerWith(REVIEWER_SET_SIGNAL_IDS, 0),
      sourceKind: 'gh-issue',
    });
    expect(out.kind).toBe('abstain');
  });
});

describe('answer cache is never used for definitions that can reduce review', () => {
  const planted = Object.fromEntries(
    REVIEWER_SET_SIGNAL_IDS.map((id) => [id, { type: 'noul' as const, probability: 0 }]),
  );

  function spyCache() {
    const gets: string[] = [];
    const puts: string[] = [];
    return {
      gets,
      puts,
      cache: {
        get: (key: string) => {
          gets.push(key);
          return { modelVersion: 'fake-1', answers: planted };
        },
        put: (key: string) => void puts.push(key),
      },
    };
  }
  const cached = (id: string, promotion: object, thresholds: Record<string, number>) => ({
    ...config(id, 'enforce', promotion as never, thresholds),
    defaults: { mode: 'shadow' as const, timeoutMs: 1000, cache: true },
  });

  it('ignores a planted cache entry for review.reviewer-set and calls the provider', async () => {
    const spy = spyCache();
    const fake = providerWith(REVIEWER_SET_SIGNAL_IDS, 0.9);
    const out = await evaluateJudgment(reviewerSetDefinition, input, {
      config: cached(
        'review.reviewer-set',
        { path: 'corpus', n: 60, actBandPrecision: 0.97 },
        SET_THRESHOLDS,
      ),
      getProvider: () => fake,
      sourceKind: 'backlog',
      cache: spy.cache,
    });
    expect(fake.requests).toHaveLength(1);
    expect(out.kind).toBe('abstain');
    expect(spy.gets).toHaveLength(0);
    expect(spy.puts).toHaveLength(0);
  });

  it('still uses the cache for a tighten definition', async () => {
    const spy = spyCache();
    const fake = providerWith(ALL_ROUTING, 0.9);
    const cfgRouting = cached('review.routing', { path: 'override', evidence: 'x' }, {});
    await evaluateJudgment(
      reviewRoutingDefinition,
      { ...input, regexReviewers: [] },
      {
        config: cfgRouting,
        getProvider: () => fake,
        cache: spy.cache,
      },
    );
    expect(spy.gets.length).toBe(1);
  });
});
