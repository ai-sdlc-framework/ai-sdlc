import { describe, expect, it } from 'vitest';
import { validateUsageConfig } from './validation.js';

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
