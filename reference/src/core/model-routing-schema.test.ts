import { describe, expect, it } from 'vitest';
import { validateModelRouting } from './validation.js';

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
});
