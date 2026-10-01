import { describe, it, expect } from 'vitest';
import { validate } from './validation.js';

const base = (spec: unknown) => ({
  apiVersion: 'ai-sdlc.io/v1alpha1',
  kind: 'JudgmentConfig',
  metadata: { name: 'x' },
  spec,
});

describe('validate(JudgmentConfig)', () => {
  it('accepts an empty spec and a full spec', () => {
    expect(validate('JudgmentConfig', base({})).valid).toBe(true);
    const full = base({
      provider: 'jev',
      model: 'jev-1.13.0',
      providerOptions: { jev: { baseUrl: 'http://localhost' } },
      egress: { allow: ['work-item-text', 'code-diff'] },
      defaults: { mode: 'shadow', timeoutMs: 1000, cache: true },
      judgments: {
        'dor.stage-b': {
          mode: 'enforce',
          thresholds: { 'jev@jev-1.13.0': { pass: 0.85 } },
          promotion: { 'jev@jev-1.13.0': { path: 'corpus', n: 75, actBandPrecision: 0.97 } },
        },
      },
    });
    expect(validate('JudgmentConfig', full).valid).toBe(true);
  });

  it('rejects bad modes, egress classes, and promotion paths', () => {
    expect(validate('JudgmentConfig', base({ defaults: { mode: 'on' } })).valid).toBe(false);
    expect(validate('JudgmentConfig', base({ egress: { allow: ['everything'] } })).valid).toBe(
      false,
    );
    expect(
      validate('JudgmentConfig', base({ judgments: { a: { promotion: { k: { path: 'x' } } } } }))
        .valid,
    ).toBe(false);
  });
});
