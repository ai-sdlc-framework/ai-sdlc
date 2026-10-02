import { describe, it, expect } from 'vitest';
import { FakeJudgmentProvider } from '../fake-provider.js';
import { evaluateJudgment } from '../evaluate.js';
import { resolveJudgmentConfig } from '../config.js';
import { getJudgmentDefinition, snapshotJudgmentDefinition } from '../catalog.js';
import { getCapability } from '../../capabilities/index.js';
import type { ComposeContext } from '../definition.js';
import type { JudgmentAnswer } from '../types.js';
import {
  DECISION_ESTIMATION_JUDGMENTS,
  decisionDuplicateDefinition,
  decisionPillarsDefinition,
  decisionReversibilityDefinition,
  decisionStageBSignalsDefinition,
  duplicateQuestionId,
  estimateClassDefinition,
  decisionState,
  thresholdOf,
  noulProbability,
  choiceAnswer,
  scoreAnswer,
} from './index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = ComposeContext<any>;
const trusted: Ctx = { permissiveAllowed: true };
const untrusted: Ctx = { permissiveAllowed: false };

const choice = (c: string, p: number, all: string[]): JudgmentAnswer => ({
  type: 'choice',
  choice: c,
  probabilities: Object.fromEntries(all.map((k) => [k, k === c ? p : (1 - p) / (all.length - 1)])),
  confidence: p,
});
const noul = (probability: number): JudgmentAnswer => ({ type: 'noul', probability });
const score = (s: number, confidence = 0.9): JudgmentAnswer => ({
  type: 'score',
  score: s,
  probabilities: [0, 0, 0, 0].map((_, i) => (i === s ? confidence : 0.05)),
  confidence,
});

const REV = ['reversible', 'one-way', 'unknown'];
const CLS = ['bug', 'feature', 'chore', 'uncategorized'];

describe('registration', () => {
  it('registers all five with the declared shape and passes the safety rules', () => {
    expect(DECISION_ESTIMATION_JUDGMENTS.map((d) => d.id)).toEqual([
      'decision.reversibility',
      'decision.pillars',
      'decision.duplicate',
      'decision.stage-b-signals',
      'estimate.class',
    ]);
    for (const def of DECISION_ESTIMATION_JUDGMENTS) {
      expect(getJudgmentDefinition(def.id)).toBeDefined();
      expect(snapshotJudgmentDefinition(def).ok).toBe(true);
      expect(def).toMatchObject({
        egressClass: 'work-item-text',
        riskClass: 'seam',
        direction: 'bidirectional',
        fallback: 'pending',
        reducesReview: false,
        reducingOutcomes: [],
      });
      expect(typeof def.agrees).toBe('function');
    }
  });

  it('names a capability on stage-b-signals and estimate.class only, and the capability exists', () => {
    const named = DECISION_ESTIMATION_JUDGMENTS.filter((d) => d.capabilityId).map((d) => [
      d.id,
      d.capabilityId,
    ]);
    expect(named).toEqual([
      ['decision.stage-b-signals', 'decisions.stage-b-signals'],
      ['estimate.class', 'estimation.class-assignment'],
    ]);
    for (const [, cap] of named) expect(getCapability(cap as string)).toBeDefined();
  });
});

describe('helpers', () => {
  it('thresholdOf falls back on a missing or non-finite value', () => {
    expect(thresholdOf({ a: 0.4 }, 'a', 0.9)).toBe(0.4);
    expect(thresholdOf({}, 'a', 0.9)).toBe(0.9);
    expect(thresholdOf({ a: Number.NaN }, 'a', 0.9)).toBe(0.9);
  });
  it('answer accessors return undefined for a missing or mistyped answer', () => {
    const answers = { q: noul(0.5) };
    expect(noulProbability(answers, 'q')).toBe(0.5);
    expect(noulProbability(answers, 'x')).toBeUndefined();
    expect(choiceAnswer(answers, 'q')).toBeUndefined();
    expect(scoreAnswer(answers, 'q')).toBeUndefined();
  });
  it('decisionState keeps only summary, body and option id and description', () => {
    expect(decisionState({ summary: 's', options: [{ id: 'a', description: 'd' }] })).toEqual({
      summary: 's',
      body: '',
      options: [{ id: 'a', description: 'd' }],
    });
  });
});

describe('decision.reversibility', () => {
  const d = decisionReversibilityDefinition;
  const input = { summary: 's' };
  const run = (ans: JudgmentAnswer | undefined, ctx: Ctx, t = {}) =>
    d.compose(ans ? { reversibility: ans } : {}, input, t, ctx);

  it('acts on one-way and unknown for any source', () => {
    for (const ctx of [trusted, untrusted]) {
      expect(run(choice('one-way', 0.95, REV), ctx)).toEqual({ kind: 'act', decision: 'one-way' });
      expect(run(choice('unknown', 0.95, REV), ctx)).toEqual({ kind: 'act', decision: 'unknown' });
    }
  });
  it('acts on reversible only for trusted work; escalates otherwise', () => {
    expect(run(choice('reversible', 0.95, REV), trusted)).toEqual({
      kind: 'act',
      decision: 'reversible',
    });
    expect(run(choice('reversible', 0.95, REV), untrusted)).toMatchObject({
      kind: 'escalate',
      reason: 'reversible-not-permitted',
    });
  });
  it('escalates on low confidence, honours a custom threshold, abstains on a missing answer', () => {
    expect(run(choice('one-way', 0.6, REV), trusted)).toMatchObject({
      kind: 'escalate',
      reason: 'low-confidence',
    });
    expect(run(choice('one-way', 0.6, REV), trusted, { reversibility: 0.5 })).toMatchObject({
      kind: 'act',
    });
    expect(run(undefined, trusted)).toEqual({ kind: 'abstain', reason: 'missing-answer' });
    expect(run(choice('bogus', 0.99, [...REV, 'bogus']), trusted)).toMatchObject({
      kind: 'abstain',
    });
  });
  it('has a question with a none-of-these option and agrees on equality', () => {
    const q = d.questions(input).reversibility;
    expect(q.type === 'choice' && Object.keys(q.options)).toEqual(REV);
    expect(d.agrees?.('one-way', 'one-way')).toBe(true);
    expect(d.agrees?.('one-way', 'reversible')).toBe(false);
  });
});

describe('decision.pillars', () => {
  const d = decisionPillarsDefinition;
  const compose = (a: Record<string, number>, t = {}) =>
    d.compose(
      Object.fromEntries(Object.entries(a).map(([k, v]) => [k, noul(v)])),
      { summary: 's' },
      t,
      trusted,
    );

  it('returns two pillars when two clear the threshold', () => {
    expect(compose({ engineering: 0.9, product: 0.8, design: 0.1 })).toEqual({
      kind: 'act',
      decision: ['engineering', 'product'],
    });
  });
  it('abstains when none clear it, so the keyword result stands', () => {
    expect(compose({ engineering: 0.2, product: 0.3, design: 0.1 })).toEqual({
      kind: 'abstain',
      reason: 'no-pillar-clears-threshold',
    });
  });
  it('honours a custom threshold and abstains on a missing answer', () => {
    expect(compose({ engineering: 0.2, product: 0.3, design: 0.1 }, { pillar: 0.25 })).toEqual({
      kind: 'act',
      decision: ['product'],
    });
    expect(compose({ engineering: 0.9 })).toEqual({ kind: 'abstain', reason: 'missing-answer' });
  });
  it('asks one Noul per pillar and compares sets in agrees', () => {
    expect(Object.keys(d.questions({ summary: 's' })).sort()).toEqual([
      'design',
      'engineering',
      'product',
    ]);
    expect(d.agrees?.(['design', 'product'], ['product', 'design'])).toBe(true);
    expect(d.agrees?.(['design'], ['product'])).toBe(false);
    expect(d.agrees?.(['design'], 'design')).toBe(false);
  });
});

describe('decision.duplicate', () => {
  const d = decisionDuplicateDefinition;
  const input = {
    summary: 's',
    candidates: [
      { id: 'DEC-0001', summary: 'a' },
      { id: 'DEC-0002', summary: 'b' },
    ],
  };
  const answers = (a: number, b: number) => ({
    [duplicateQuestionId('DEC-0001')]: noul(a),
    [duplicateQuestionId('DEC-0002')]: noul(b),
  });

  it('asks one question per shortlisted pair', () => {
    expect(Object.keys(d.questions(input))).toEqual(['dup-DEC-0001', 'dup-DEC-0002']);
    expect(d.buildState(input)).toMatchObject({
      candidates: [{ id: 'DEC-0001' }, { id: 'DEC-0002' }],
    });
  });
  it('declares the most likely duplicate on trusted work', () => {
    expect(d.compose(answers(0.92, 0.97), input, {}, trusted)).toEqual({
      kind: 'act',
      decision: { duplicateOf: 'DEC-0002' },
    });
  });
  it('does not act on a declared duplicate for untrusted work', () => {
    expect(d.compose(answers(0.92, 0.97), input, {}, untrusted)).toMatchObject({
      kind: 'escalate',
      reason: 'duplicate-not-permitted',
    });
  });
  it('acts with no duplicate when no pair clears the threshold', () => {
    expect(d.compose(answers(0.2, 0.3), input, {}, untrusted)).toEqual({
      kind: 'act',
      decision: { duplicateOf: null },
    });
    expect(d.compose(answers(0.2, 0.3), input, { duplicate: 0.25 }, trusted)).toEqual({
      kind: 'act',
      decision: { duplicateOf: 'DEC-0002' },
    });
  });
  it('abstains on a missing answer and compares in agrees', () => {
    expect(d.compose({}, input, {}, trusted)).toEqual({
      kind: 'abstain',
      reason: 'missing-answer',
    });
    expect(d.agrees?.({ duplicateOf: null }, null)).toBe(true);
    expect(d.agrees?.({ duplicateOf: 'DEC-0001' }, 'DEC-0001')).toBe(true);
    expect(d.agrees?.({ duplicateOf: 'DEC-0001' }, 'DEC-0002')).toBe(false);
    expect(d.agrees?.({ duplicateOf: 'DEC-0001' }, undefined)).toBe(false);
  });
});

describe('decision.stage-b-signals', () => {
  const d = decisionStageBSignalsDefinition;
  const input = { summary: 's', exemplars: [{ id: 'e1', label: 'true-positive', summary: 'x' }] };

  it('sends both questions in one set with four levels each and the exemplars in the state', () => {
    const qs = d.questions(input);
    expect(Object.keys(qs)).toEqual(['novelty', 'exemplarSimilarity']);
    for (const q of Object.values(qs)) expect(q.type === 'score' && q.levels).toHaveLength(4);
    expect(d.buildState(input)).toMatchObject({ exemplars: [{ id: 'e1', rationale: '' }] });
  });
  it('normalises level / 3 and lowers a signal below the baseline', () => {
    const out = d.compose({ novelty: score(0), exemplarSimilarity: score(1) }, input, {}, trusted);
    expect(out).toEqual({ kind: 'act', decision: { novelty: 0, exemplarSimilarity: 1 / 3 } });
  });
  it('never lifts a signal above the 0.5 baseline', () => {
    const out = d.compose({ novelty: score(3), exemplarSimilarity: score(2) }, input, {}, trusted);
    expect(out).toEqual({ kind: 'act', decision: { novelty: 0.5, exemplarSimilarity: 0.5 } });
  });
  it.each([Number.NaN, -1, 4, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'falls back to the 0.5 baseline for a malformed level %s, never a NaN signal',
    (bad) => {
      const out = d.compose(
        { novelty: score(bad), exemplarSimilarity: score(0) },
        input,
        {},
        trusted,
      );
      expect(out).toEqual({ kind: 'act', decision: { novelty: 0.5, exemplarSimilarity: 0 } });
      const both = d.compose(
        { novelty: score(bad), exemplarSimilarity: score(bad) },
        input,
        {},
        trusted,
      );
      expect(both).toEqual({ kind: 'act', decision: { novelty: 0.5, exemplarSimilarity: 0.5 } });
    },
  );
  it('treats a non-finite confidence as below the minimum', () => {
    const out = d.compose(
      { novelty: score(0, Number.NaN), exemplarSimilarity: score(0) },
      input,
      {},
      trusted,
    );
    expect(out).toEqual({ kind: 'act', decision: { novelty: 0.5, exemplarSimilarity: 0 } });
  });
  it('leaves a low-confidence signal at the baseline', () => {
    const out = d.compose(
      { novelty: score(0, 0.3), exemplarSimilarity: score(0) },
      input,
      {},
      trusted,
    );
    expect(out).toEqual({ kind: 'act', decision: { novelty: 0.5, exemplarSimilarity: 0 } });
    expect(
      d.compose(
        { novelty: score(0, 0.3), exemplarSimilarity: score(0) },
        input,
        { minConfidence: 0.2 },
        trusted,
      ),
    ).toEqual({ kind: 'act', decision: { novelty: 0, exemplarSimilarity: 0 } });
  });
  it('abstains on a missing answer and compares in agrees', () => {
    expect(d.compose({ novelty: score(0) }, input, {}, trusted)).toEqual({
      kind: 'abstain',
      reason: 'missing-answer',
    });
    expect(
      d.agrees?.({ novelty: 0, exemplarSimilarity: 0.5 }, { novelty: 0, exemplarSimilarity: 0.5 }),
    ).toBe(true);
    expect(
      d.agrees?.(
        { novelty: 0, exemplarSimilarity: 0.5 },
        { novelty: 0.5, exemplarSimilarity: 0.5 },
      ),
    ).toBe(false);
    expect(d.agrees?.({ novelty: 0, exemplarSimilarity: 0.5 }, 'x')).toBe(false);
  });
});

describe('estimate.class', () => {
  const d = estimateClassDefinition;
  const input = { title: 't' };
  const run = (a: JudgmentAnswer | undefined, t = {}) =>
    d.compose(a ? { class: a } : {}, input, t, trusted);

  it('acts on a confident bug, feature or chore', () => {
    expect(run(choice('bug', 0.9, CLS))).toEqual({ kind: 'act', decision: 'bug' });
    expect(run(choice('chore', 0.9, CLS))).toEqual({ kind: 'act', decision: 'chore' });
  });
  it('abstains on uncategorized so the regex still decides', () => {
    expect(run(choice('uncategorized', 0.99, CLS))).toEqual({
      kind: 'abstain',
      reason: 'judged-uncategorized',
    });
  });
  it('escalates on low confidence, honours a threshold, abstains on a missing answer', () => {
    expect(run(choice('bug', 0.5, CLS))).toMatchObject({ kind: 'escalate' });
    expect(run(choice('bug', 0.5, CLS), { class: 0.4 })).toMatchObject({ kind: 'act' });
    expect(run(undefined)).toEqual({ kind: 'abstain', reason: 'missing-answer' });
    expect(run(choice('nope', 0.9, [...CLS, 'nope']))).toMatchObject({ kind: 'abstain' });
  });
  it('builds a state of title and description', () => {
    expect(d.buildState({ title: 't', description: 'x' })).toEqual({
      title: 't',
      description: 'x',
    });
    expect(d.buildState({ title: 't' })).toEqual({ title: 't', description: '' });
    expect(d.agrees?.('bug', 'bug')).toBe(true);
  });
});

describe('through evaluateJudgment', () => {
  function cfg(id: string, mode: 'enforce' | 'shadow', allow = ['work-item-text']) {
    return resolveJudgmentConfig({
      spec: {
        provider: 'fake',
        model: 'fake-1',
        egress: { allow },
        defaults: { mode: 'shadow' },
        judgments: {
          [id]: {
            mode,
            thresholds: { 'fake@fake-1': { x: 0.5 } },
            promotion: { 'fake@fake-1': { path: 'override', evidence: 'reviewed 20 items' } },
          },
        },
      },
    });
  }

  it('estimate.class acts in enforce and abstains with shadow', async () => {
    const p = new FakeJudgmentProvider().script('class', choice('bug', 0.95, CLS));
    const get = () => p;
    const act = await evaluateJudgment(
      estimateClassDefinition,
      { title: 't' },
      {
        config: cfg('estimate.class', 'enforce'),
        getProvider: get,
        sourceKind: 'backlog',
      },
    );
    expect(act).toEqual({ kind: 'act', decision: 'bug' });
    const shadow = await evaluateJudgment(
      estimateClassDefinition,
      { title: 't' },
      {
        config: cfg('estimate.class', 'shadow'),
        getProvider: get,
      },
    );
    expect(shadow).toEqual({ kind: 'abstain', reason: 'shadow' });
  });

  it('reversible and a declared duplicate are not acted on for gh-issue', async () => {
    const p = new FakeJudgmentProvider()
      .script('reversibility', choice('reversible', 0.95, REV))
      .script('dup-DEC-0001', noul(0.99));
    const get = () => p;
    const rev = await evaluateJudgment(
      decisionReversibilityDefinition,
      { summary: 's' },
      {
        config: cfg('decision.reversibility', 'enforce'),
        getProvider: get,
        sourceKind: 'gh-issue',
      },
    );
    expect(rev).toMatchObject({ kind: 'escalate' });
    const dup = await evaluateJudgment(
      decisionDuplicateDefinition,
      { summary: 's', candidates: [{ id: 'DEC-0001', summary: 'a' }] },
      { config: cfg('decision.duplicate', 'enforce'), getProvider: get, sourceKind: 'gh-issue' },
    );
    expect(dup).toMatchObject({ kind: 'escalate' });
  });

  it('puts all duplicate questions in one request', async () => {
    const p = new FakeJudgmentProvider()
      .script('dup-DEC-0001', noul(0.1))
      .script('dup-DEC-0002', noul(0.1));
    await evaluateJudgment(
      decisionDuplicateDefinition,
      {
        summary: 's',
        candidates: [
          { id: 'DEC-0001', summary: 'a' },
          { id: 'DEC-0002', summary: 'b' },
        ],
      },
      { config: cfg('decision.duplicate', 'shadow'), getProvider: () => p },
    );
    expect(p.requests).toHaveLength(1);
    expect(Object.keys(p.requests[0].questions)).toEqual(['dup-DEC-0001', 'dup-DEC-0002']);
  });
});
