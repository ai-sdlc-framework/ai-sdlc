import { describe, it, expect } from 'vitest';
import { routedModel } from './role-model.js';

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
