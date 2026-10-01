import { describe, it, expect } from 'vitest';
import {
  registerJudgmentDefinition,
  getJudgmentDefinition,
  listJudgmentDefinitions,
} from './catalog.js';
import { questionSetHash, canonicalJson } from './question-hash.js';
import type { JudgmentDefinition } from './definition.js';

function def(
  id: string,
  over: { version?: number; text?: string; option?: string } = {},
): JudgmentDefinition<{ n: number }, string> {
  return {
    id,
    version: over.version ?? 1,
    egressClass: 'work-item-text',
    direction: 'tighten-only',
    riskClass: 'tighten',
    buildState: () => 'state',
    questions: () => ({
      q: {
        type: 'choice',
        instructions: over.text ?? 'pick',
        options: { a: over.option ?? 'first', b: 'second' },
      },
    }),
    compose: () => ({ kind: 'abstain', reason: 'x' }),
  };
}

describe('judgment catalog', () => {
  it('registers, gets and lists; rejects duplicates', () => {
    const d = def('catalog.test.one');
    registerJudgmentDefinition(d);
    expect(getJudgmentDefinition('catalog.test.one')).toBe(d);
    expect(listJudgmentDefinitions()).toContain(d);
    expect(() => registerJudgmentDefinition(def('catalog.test.one'))).toThrow(/already registered/);
    expect(getJudgmentDefinition('catalog.test.missing')).toBeUndefined();
  });
});

describe('questionSetHash', () => {
  const probe = { n: 1 };
  it('is stable and changes with text, option or version', () => {
    const base = questionSetHash(def('h'), probe);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(questionSetHash(def('h'), probe)).toBe(base);
    expect(questionSetHash(def('h', { text: 'other' }), probe)).not.toBe(base);
    expect(questionSetHash(def('h', { option: 'changed' }), probe)).not.toBe(base);
    expect(questionSetHash(def('h', { version: 2 }), probe)).not.toBe(base);
  });

  it('canonicalJson sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: undefined }] })).toBe('{"a":[{"d":1}],"b":1}');
    expect(canonicalJson(undefined)).toBe('null');
  });
});
