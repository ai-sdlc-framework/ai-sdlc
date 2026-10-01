import { describe, expect, it } from 'vitest';
import type { ModelCallRecord, PriceRow } from '@ai-sdlc/reference';
import {
  TOKEN_CLASSES,
  UNITS_PROXY_NOTE,
  describeWeights,
  deriveUnitWeights,
  hasModelWeight,
  modelMultiplier,
  unitsForCall,
} from './units.js';

function price(model: string, input: number, extra: Partial<PriceRow> = {}): PriceRow {
  return {
    model,
    inputPer1M: input,
    outputPer1M: input * 5,
    cacheReadPer1M: input * 0.1,
    cacheWrite5mPer1M: input * 1.25,
    cacheWrite1hPer1M: input * 2,
    source: 'test',
    url: 'https://example.invalid/prices',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    effectiveFrom: '2026-01-01',
    status: 'active',
    ...extra,
  };
}

const ROWS = [price('model-sonnet-a', 2), price('model-opus-a', 10), price('model-haiku-a', 1)];
const AT = '2026-06-01T00:00:00.000Z';

function call(model: string, tokens: Partial<ModelCallRecord['tokens']>): ModelCallRecord {
  return {
    schemaVersion: 'v1',
    callId: 'c1',
    ts: AT,
    harness: 'claude-code',
    provider: 'anthropic',
    model,
    tokens: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, ...tokens },
    billingPool: 'subscription-interactive',
    sessionId: 's1',
    agentRole: 'main-session',
    scope: 'framework',
  };
}

describe('deriveUnitWeights', () => {
  it('derives class and model ratios from the price rows, reference input token = 1 unit', () => {
    const w = deriveUnitWeights(ROWS, AT);
    expect(w.basis).toBe('price-history');
    expect(w.referenceModel).toBe('model-sonnet-a');
    expect(w.tokenClasses.input).toBeCloseTo(1);
    expect(w.tokenClasses.output).toBeCloseTo(5);
    expect(w.tokenClasses.cacheRead).toBeCloseTo(0.1);
    expect(w.modelMultipliers['model-opus-a']).toBeCloseTo(5);
    expect(w.modelMultipliers['model-haiku-a']).toBeCloseTo(0.5);
    expect(w.overrides).toEqual([]);
  });

  it('follows the price feed: a later row changes the weights', () => {
    const rows = [...ROWS, price('model-opus-a', 20, { effectiveFrom: '2026-05-01' })];
    expect(deriveUnitWeights(rows, AT).modelMultipliers['model-opus-a']).toBeCloseTo(10);
    expect(
      deriveUnitWeights(rows, '2026-04-01T00:00:00.000Z').modelMultipliers['model-opus-a'],
    ).toBeCloseTo(5);
  });

  it('falls back to built-in ratios when there are no rows', () => {
    const w = deriveUnitWeights([], AT);
    expect(w.basis).toBe('built-in-ratios');
    expect(w.referenceModel).toBeUndefined();
    expect(w.tokenClasses.output).toBe(5);
    expect(describeWeights(w)).toContain('built-in price ratios');
  });

  it('uses the first model as reference when none is a sonnet', () => {
    const w = deriveUnitWeights([price('zeta', 4), price('alpha', 2)], AT);
    expect(w.referenceModel).toBe('alpha');
  });

  it('lets explicit config weights override the derived ones', () => {
    const w = deriveUnitWeights(ROWS, AT, {
      tokenClasses: { output: 7 },
      modelFamilies: { opus: 2 },
    });
    expect(w.tokenClasses.output).toBe(7);
    expect(w.tokenClasses.input).toBeCloseTo(1);
    expect(w.overrides.sort()).toEqual(['modelFamilies.opus', 'tokenClasses.output']);
    expect(modelMultiplier('model-opus-a', w)).toBe(2);
    expect(describeWeights(w)).toContain('overridden');
  });
});

describe('unitsForCall', () => {
  const w = deriveUnitWeights(ROWS, AT);

  it('sums token classes by weight and scales by the model multiplier', () => {
    const c = call('model-opus-a', {
      input: 100,
      output: 10,
      cacheRead: 1000,
      cacheWrite5m: 80,
      cacheWrite1h: 50,
    });
    const perClass = 100 * 1 + 10 * 5 + 1000 * 0.1 + 80 * 1.25 + 50 * 2;
    expect(unitsForCall(c, w)).toBeCloseTo(perClass * 5);
  });

  it('counts an unknown model at the neutral multiplier and reports it has no weight', () => {
    expect(modelMultiplier('mystery', w)).toBe(1);
    expect(hasModelWeight('mystery', w)).toBe(false);
    expect(hasModelWeight('model-opus-a', w)).toBe(true);
    expect(unitsForCall(call('mystery', { input: 10 }), w)).toBeCloseTo(10);
  });

  it('every token class is weighted', () => {
    for (const c of TOKEN_CLASSES) {
      expect(unitsForCall(call('model-sonnet-a', { [c]: 1 }), w)).toBeCloseTo(w.tokenClasses[c]);
    }
  });

  it('states that the weights are a proxy', () => {
    expect(UNITS_PROXY_NOTE).toMatch(/proxy/);
    expect(describeWeights(w)).toMatch(/proxy/);
  });
});
