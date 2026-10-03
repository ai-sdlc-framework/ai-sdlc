import { describe, expect, it } from 'vitest';
import { validateModelRouting, validateResource } from './validation.js';

const valid = {
  apiVersion: 'ai-sdlc.io/v1alpha1',
  kind: 'ModelRouting',
  spec: {
    strength: ['haiku', 'sonnet', 'opus'],
    exploreShare: 0.1,
    salt: 's',
    cells: {
      developer: { chore: { model: 'sonnet', candidates: ['haiku'] } },
      'security-reviewer': { '*': { model: 'opus' } },
    },
    evidence: { 'developer.chore': { report: 'r.json', n: 34, firstPassApproval: 0.88 } },
  },
};

describe('ModelRouting schema', () => {
  it('accepts a valid table', () => {
    expect(validateModelRouting(valid).valid).toBe(true);
  });

  it('rejects a wrong kind, a missing strength, a bad share and an empty candidates list', () => {
    expect(validateModelRouting({ ...valid, kind: 'Other' }).valid).toBe(false);
    expect(
      validateModelRouting({ ...valid, spec: { ...valid.spec, strength: undefined } }).valid,
    ).toBe(false);
    expect(validateModelRouting({ ...valid, spec: { ...valid.spec, exploreShare: 2 } }).valid).toBe(
      false,
    );
    expect(
      validateModelRouting({
        ...valid,
        spec: { ...valid.spec, cells: { developer: { '*': { model: 'sonnet', candidates: [] } } } },
      }).valid,
    ).toBe(false);
  });

  it('accepts the optional per-cell evidence reference and previous model', () => {
    const withCell = (cell: Record<string, unknown>) => ({
      ...valid,
      spec: { ...valid.spec, cells: { developer: { chore: { model: 'haiku', ...cell } } } },
    });
    expect(
      validateModelRouting(withCell({ evidence: 'ev/dev.chore.json', previousModel: 'sonnet' }))
        .valid,
    ).toBe(true);
    expect(validateModelRouting(withCell({ evidence: '' })).valid).toBe(false);
    expect(validateModelRouting(withCell({ evidence: 'x'.repeat(501) })).valid).toBe(false);
    expect(validateModelRouting(withCell({ previousModel: '' })).valid).toBe(false);
    expect(validateModelRouting(withCell({ previousModel: 'x'.repeat(201) })).valid).toBe(false);
    expect(validateModelRouting(withCell({ evidence: 5 })).valid).toBe(false);
  });
});

describe('validateResource with a ModelRouting document', () => {
  it('validates the table against its schema instead of skipping it as an unknown kind', () => {
    const r = validateResource(valid);
    expect(r.valid).toBe(true);
    expect(r.skipped).toBeUndefined();
  });

  it('reports schema errors for an invalid table', () => {
    const r = validateResource({ ...valid, spec: { cells: {} } });
    expect(r.valid).toBe(false);
    expect(r.skipped).toBeUndefined();
    expect(r.errors?.length).toBeGreaterThan(0);
  });

  it('still skips a typo of the kind', () => {
    const r = validateResource({ ...valid, kind: 'ModelRoutng' });
    expect(r).toEqual({ valid: true, skipped: true });
  });
});
