import { describe, expect, it } from 'vitest';
import { validateResource, validateUsageConfig } from './validation.js';

const base = {
  apiVersion: 'ai-sdlc.io/v1alpha1',
  kind: 'UsageConfig',
  metadata: { name: 'usage' },
};

describe('UsageConfig schema', () => {
  it('accepts a full document', () => {
    const r = validateUsageConfig({
      ...base,
      spec: {
        plan: { name: 'plan-a', monthlyPriceUsd: 200 },
        windows: [
          { name: 'session', lengthHours: 5, mode: 'first-use' },
          { name: 'weekly', lengthHours: 168, mode: 'fixed', anchor: '2026-09-01T00:00:00Z' },
        ],
        weights: {
          tokenClasses: { input: 1, output: 5 },
          modelFamilies: { opus: 1.7 },
        },
        allotmentTolerance: 0.25,
        modelMixSimilarity: 0.8,
        scorecardMinTasks: 30,
      },
    });
    expect(r.valid).toBe(true);
  });

  it('accepts an empty spec so every default applies', () => {
    expect(validateUsageConfig({ ...base, spec: {} }).valid).toBe(true);
  });

  it.each([
    ['wrong kind', { ...base, kind: 'Other', spec: {} }],
    ['missing spec', { ...base }],
    ['unknown spec field', { ...base, spec: { surprise: true } }],
    ['zero tolerance', { ...base, spec: { allotmentTolerance: 0 } }],
    ['non-integer scorecard threshold', { ...base, spec: { scorecardMinTasks: 2.5 } }],
    ['similarity above 1', { ...base, spec: { modelMixSimilarity: 1.5 } }],
    ['negative weight', { ...base, spec: { weights: { tokenClasses: { input: -1 } } } }],
    ['zero-length window', { ...base, spec: { windows: [{ name: 'w', lengthHours: 0 }] } }],
    ['empty windows list', { ...base, spec: { windows: [] } }],
    [
      'unknown window mode',
      { ...base, spec: { windows: [{ name: 'w', lengthHours: 1, mode: 'x' }] } },
    ],
    ['negative price', { ...base, spec: { plan: { monthlyPriceUsd: -1 } } }],
  ])('rejects %s', (_label, doc) => {
    expect(validateUsageConfig(doc).valid).toBe(false);
  });
});

describe('validateResource with a UsageConfig document', () => {
  it('validates against the usage config schema instead of skipping', () => {
    const bad = validateResource({ ...base });
    expect(bad.valid).toBe(false);
    expect(bad.skipped).toBeUndefined();
    const good = validateResource({ ...base, spec: {} });
    expect(good.skipped).toBeUndefined();
    expect(good.valid).toBe(validateUsageConfig({ ...base, spec: {} }).valid);
  });

  it('validates a UsageConfig through validateResource', () => {
    const r = validateResource({ ...base, spec: {} });
    expect(r.valid).toBe(true);
    expect(r.skipped).toBeUndefined();
  });

  it('reports an error path for an invalid UsageConfig through validateResource', () => {
    const r = validateResource({ ...base, spec: { allotmentTolerance: 0 } });
    expect(r.valid).toBe(false);
    expect(r.errors?.[0].path).toContain('allotmentTolerance');
  });

  it('skips a typo of the UsageConfig kind', () => {
    const r = validateResource({ ...base, kind: 'UsageConfg', spec: {} });
    expect(r).toEqual({ valid: true, skipped: true });
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'treats inherited property name %s as an unknown kind without throwing',
    (kind) => {
      expect(validateResource({ kind, apiVersion: 'x' })).toEqual({ valid: true, skipped: true });
    },
  );
});
