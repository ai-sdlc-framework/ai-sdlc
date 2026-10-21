import { describe, it, expect } from 'vitest';
import { resolveReviewerHarnessSetting, routedModel } from './role-model.js';

const table = `apiVersion: ai-sdlc.io/v1alpha1
kind: ModelRouting
metadata:
  name: model-routing
spec:
  strength: [haiku, sonnet, opus]
  exploreShare: 0
  salt: s
  cells:
    developer:
      '*': { model: opus }
`;

describe('routedModel', () => {
  it('reads the wildcard cell of the table', () => {
    expect(routedModel('developer', { readBaseTable: () => table })).toBe('opus');
  });
  it('falls back to the built-in default when the table has no cell', () => {
    expect(routedModel('review-executor', { readBaseTable: () => table })).toBe('haiku');
    expect(routedModel('planner', { readBaseTable: () => null })).toBe('fable');
  });
  it('throws for a role with neither cell nor default', () => {
    expect(() => routedModel('nope', { readBaseTable: () => null })).toThrow(/nope/);
  });
});

describe('resolveReviewerHarnessSetting (AISDLC-1003)', () => {
  const withHarness = (h: string): string => table.replace('  cells:', `  harness: ${h}\n  cells:`);

  it('defaults to codex when neither the key nor the env var is set', () => {
    expect(resolveReviewerHarnessSetting(undefined, { readBaseTable: () => table })).toEqual({
      harness: 'codex',
      source: 'default',
    });
    expect(resolveReviewerHarnessSetting('', { readBaseTable: () => null })).toEqual({
      harness: 'codex',
      source: 'default',
    });
  });
  it('uses the yaml key when the env var is unset', () => {
    expect(
      resolveReviewerHarnessSetting(undefined, { readBaseTable: () => withHarness('claude') }),
    ).toEqual({ harness: 'claude', source: 'yaml' });
  });
  it('lets the env var override the yaml key', () => {
    expect(
      resolveReviewerHarnessSetting('codex', { readBaseTable: () => withHarness('claude') }),
    ).toEqual({ harness: 'codex', source: 'env' });
    expect(
      resolveReviewerHarnessSetting('CLAUDE', { readBaseTable: () => withHarness('codex') }),
    ).toEqual({ harness: 'claude', source: 'env' });
  });
  it('ignores an invalid yaml value (falls back to the default table)', () => {
    expect(
      resolveReviewerHarnessSetting(undefined, { readBaseTable: () => withHarness('gpt') }),
    ).toEqual({ harness: 'codex', source: 'default' });
  });
});
