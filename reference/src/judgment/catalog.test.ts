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
    expect(getJudgmentDefinition('catalog.test.one')).toMatchObject({ id: 'catalog.test.one' });
    expect(listJudgmentDefinitions().map((x) => x.id)).toContain(d.id);
    expect(() => registerJudgmentDefinition(def('catalog.test.one'))).toThrow(/already registered/);
    expect(getJudgmentDefinition('catalog.test.missing')).toBeUndefined();
  });
});

describe('registration-time safety rules', () => {
  type Over = Partial<JudgmentDefinition<{ n: number }, string>>;
  const mk = (id: string, over: Over): JudgmentDefinition<{ n: number }, string> => ({
    ...def(id),
    ...over,
  });
  const bad = (id: string, over: Over, re: RegExp) => {
    expect(() => registerJudgmentDefinition(mk(id, over))).toThrow(re);
    expect(getJudgmentDefinition(id)).toBeUndefined();
  };

  it('rule (a): seam requires fallback pending', () => {
    bad('safety.a1', { riskClass: 'seam' }, /safety\.a1.*rule \(a\)/);
    bad('safety.a2', { riskClass: 'seam', fallback: 'other' as never }, /rule \(a\)/);
  });

  it('rule (b): seam + bidirectional needs explicit empty reducingOutcomes', () => {
    const base: Over = {
      riskClass: 'seam',
      fallback: 'pending',
      direction: 'bidirectional',
      reducesReview: false,
    };
    bad('safety.b1', base, /rule \(b\)/);
    bad('safety.b2', { ...base, reducingOutcomes: ['skip'] }, /rule \(b\)/);
    registerJudgmentDefinition(mk('safety.b3', { ...base, direction: 'tighten-only' }));
    expect(getJudgmentDefinition('safety.b3')).toBeDefined();
  });

  it('rule (c): reducing review requires relax and consistency', () => {
    bad('safety.c1', { reducesReview: true }, /rule \(c\)/);
    bad('safety.c2', { riskClass: 'relax', reducingOutcomes: ['skip'] }, /rule \(c\)/);
    bad(
      'safety.c3',
      { riskClass: 'tighten', reducesReview: true, reducingOutcomes: ['skip'] },
      /rule \(c\)/,
    );
    bad('safety.c4', { reducingOutcomes: ['skip'], reducesReview: false }, /rule \(c\)/);
  });

  it('rule (d): bidirectional must declare reducesReview explicitly', () => {
    bad('safety.d1', { riskClass: 'tighten', direction: 'bidirectional' }, /rule \(d\)/);
    bad('safety.d2', { riskClass: 'relax', direction: 'bidirectional' }, /rule \(d\)/);
    registerJudgmentDefinition(
      mk('safety.d3', { riskClass: 'relax', direction: 'bidirectional', reducesReview: true }),
    );
    registerJudgmentDefinition(mk('safety.d4', { direction: 'tighten-only' }));
  });

  it('rejects an empty id and empty-string reducing outcomes', () => {
    expect(() => registerJudgmentDefinition(mk('', {}))).toThrow(/id must be a non-empty/);
    bad(
      'safety.e1',
      { riskClass: 'relax', reducesReview: true, reducingOutcomes: [''] },
      /non-empty strings/,
    );
  });

  it('stores a frozen snapshot immune to later mutation', () => {
    const d = mk('safety.f1', { riskClass: 'relax', reducesReview: true, reducingOutcomes: ['x'] });
    registerJudgmentDefinition(d);
    (d as { riskClass: string }).riskClass = 'tighten';
    (d.reducingOutcomes as string[]).push('y');
    const stored = getJudgmentDefinition('safety.f1')!;
    expect(stored.riskClass).toBe('relax');
    expect(stored.reducingOutcomes).toEqual(['x']);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(stored.compose({}, { n: 1 }, {}, { permissiveAllowed: false })).toEqual({
      kind: 'abstain',
      reason: 'x',
    });
  });

  it('reads each field once, so a stateful getter cannot pass validation then change', () => {
    let reads = 0;
    const d = mk('safety.f2', {});
    Object.defineProperty(d, 'riskClass', {
      enumerable: true,
      get: () => (reads++ === 0 ? 'tighten' : 'seam'),
    });
    registerJudgmentDefinition(d);
    expect(getJudgmentDefinition('safety.f2')!.riskClass).toBe('tighten');
    expect(reads).toBe(1);
  });

  it('rejects a definition whose getter throws', () => {
    const d = mk('safety.f3', {});
    Object.defineProperty(d, 'direction', {
      get: () => {
        throw new Error('boom');
      },
    });
    expect(() => registerJudgmentDefinition(d)).toThrow(/could not be read/);
    expect(getJudgmentDefinition('safety.f3')).toBeUndefined();
  });

  it('rejects garbage runtime values', () => {
    bad('safety.g1', { riskClass: 'nope' as never }, /riskClass must be/);
    bad('safety.g2', { direction: 'sideways' as never }, /direction must be/);
    bad('safety.g3', { reducesReview: 'yes' as never }, /reducesReview must be a boolean/);
    bad('safety.g4', { reducingOutcomes: 'skip' as never }, /array of non-empty strings/);
    bad('safety.g5', { reducingOutcomes: [1] as never }, /array of non-empty strings/);
  });

  it('accepts the conforming shapes', () => {
    registerJudgmentDefinition(
      mk('safety.p1', { riskClass: 'tighten', direction: 'bidirectional', reducesReview: false }),
    );
    registerJudgmentDefinition(
      mk('safety.p2', {
        riskClass: 'seam',
        fallback: 'pending',
        direction: 'bidirectional',
        reducingOutcomes: [],
        reducesReview: false,
      }),
    );
    registerJudgmentDefinition(
      mk('safety.p3', { riskClass: 'relax', reducesReview: true, reducingOutcomes: ['skip'] }),
    );
    for (const id of ['safety.p1', 'safety.p2', 'safety.p3']) {
      expect(getJudgmentDefinition(id)).toBeDefined();
    }
  });

  it('leaves the registry untouched on rejection', () => {
    const before = listJudgmentDefinitions().length;
    expect(() => registerJudgmentDefinition(mk('safety.n1', { riskClass: 'seam' }))).toThrow();
    expect(listJudgmentDefinitions().length).toBe(before);
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
