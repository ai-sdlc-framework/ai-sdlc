import { describe, expect, it } from 'vitest';
import { getJudgmentDefinition } from '../catalog.js';
import {
  AC_COVERAGE_DEFAULT_THRESHOLD,
  acCoverageJudgment,
  extractExcerpt,
  findingGroundingJudgment,
  registerBuiltInJudgmentDefinitions,
  type GroundingItem,
} from './index.js';

const ctx = { permissiveAllowed: false };

describe('catalog registration', () => {
  it('registers both definitions once and is idempotent', () => {
    registerBuiltInJudgmentDefinitions();
    registerBuiltInJudgmentDefinitions();
    expect(getJudgmentDefinition('dev.ac-coverage')).toBe(acCoverageJudgment);
    expect(getJudgmentDefinition('review.finding-grounding')).toBe(findingGroundingJudgment);
  });

  it('declares the required classes', () => {
    expect(acCoverageJudgment).toMatchObject({
      egressClass: 'code-diff',
      riskClass: 'tighten',
      direction: 'tighten-only',
    });
    expect(findingGroundingJudgment).toMatchObject({
      egressClass: 'agent-output',
      riskClass: 'tighten',
      direction: 'tighten-only',
    });
  });
});

describe('dev.ac-coverage', () => {
  const input = { acceptanceCriteria: ['a', 'b', 'c'], diff: 'diff --git' };

  it('builds one noul per criterion referring to its array path', () => {
    const q = acCoverageJudgment.questions(input);
    expect(Object.keys(q)).toEqual(['ac-0', 'ac-1', 'ac-2']);
    expect(JSON.stringify(q['ac-1'])).toContain('acceptanceCriteria[1]');
    expect(q['ac-0'].type).toBe('noul');
    expect(acCoverageJudgment.buildState(input)).toEqual({
      acceptanceCriteria: ['a', 'b', 'c'],
      diff: 'diff --git',
    });
  });

  it('flags criteria below the default threshold and escalates', () => {
    const out = acCoverageJudgment.compose(
      {
        'ac-0': { type: 'noul', probability: 0.9 },
        'ac-1': { type: 'noul', probability: 0.2 },
        'ac-2': { type: 'noul', probability: AC_COVERAGE_DEFAULT_THRESHOLD },
      },
      input,
      {},
      ctx,
    );
    expect(out.kind).toBe('escalate');
    if (out.kind !== 'escalate') return;
    expect(out.partial?.uncovered).toBe(1);
    expect(out.partial?.criteria?.map((c) => c.likelyUncovered)).toEqual([false, true, false]);
    expect(out.reason).toBe('1 of 3 acceptance criteria look uncovered by the diff');
  });

  it('uses a configured threshold and acts when all covered', () => {
    const answers = {
      'ac-0': { type: 'noul' as const, probability: 0.7 },
      'ac-1': { type: 'noul' as const, probability: 0.7 },
      'ac-2': { type: 'noul' as const, probability: 0.7 },
    };
    expect(acCoverageJudgment.compose(answers, input, { covered: 0.9 }, ctx).kind).toBe('escalate');
    const out = acCoverageJudgment.compose(answers, input, { covered: 0.6 }, ctx);
    expect(out).toMatchObject({ kind: 'act', decision: { uncovered: 0 } });
  });

  it('treats a missing answer as uncovered', () => {
    const out = acCoverageJudgment.compose({}, { acceptanceCriteria: ['a'], diff: 'd' }, {}, ctx);
    expect(out.kind).toBe('escalate');
  });
});

describe('extractExcerpt', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

  it('returns the line with 30 lines of context either side', () => {
    const r = extractExcerpt(text, 50)!;
    expect(r.excerptStart).toBe(20);
    const lines = r.excerpt.split('\n');
    expect(lines).toHaveLength(61);
    expect(lines[0]).toBe('line 20');
    expect(lines[60]).toBe('line 80');
  });

  it('clamps at file boundaries', () => {
    expect(extractExcerpt(text, 1)!.excerptStart).toBe(1);
    expect(extractExcerpt(text, 100)!.excerpt.endsWith('line 100')).toBe(true);
  });

  it('rejects out-of-range and non-integer lines', () => {
    expect(extractExcerpt(text, 101)).toBeUndefined();
    expect(extractExcerpt(text, 0)).toBeUndefined();
    expect(extractExcerpt(text, 1.5)).toBeUndefined();
    expect(extractExcerpt('', 1)).toBeUndefined();
  });
});

describe('review.finding-grounding', () => {
  const item = (id: string): GroundingItem => ({
    id,
    agentId: 'code-reviewer',
    findingIndex: 0,
    claim: 'x is null',
    file: 'a.ts',
    line: 3,
    excerptStart: 1,
    excerpt: 'code',
  });
  const input = { items: [item('finding-0'), item('finding-1')] };

  it('asks one choice per finding over the four relations', () => {
    const q = findingGroundingJudgment.questions(input);
    expect(Object.keys(q)).toEqual(['finding-0', 'finding-1']);
    const first = q['finding-0'];
    expect(first.type).toBe('choice');
    if (first.type === 'choice') {
      expect(Object.keys(first.options)).toEqual([
        'supports',
        'contradicts',
        'unrelated',
        'cannot-tell',
      ]);
    }
    expect(JSON.stringify(findingGroundingJudgment.buildState(input))).toContain('excerpt');
  });

  const answer = (choice: string) => ({
    type: 'choice' as const,
    choice,
    probabilities: { [choice]: 0.9 },
    confidence: 0.9,
  });

  it('acts when nothing is flagged', () => {
    const out = findingGroundingJudgment.compose(
      { 'finding-0': answer('supports'), 'finding-1': answer('cannot-tell') },
      input,
      {},
      ctx,
    );
    expect(out.kind).toBe('act');
  });

  it('escalates on contradicts / unrelated and keeps one annotation per finding', () => {
    const out = findingGroundingJudgment.compose(
      { 'finding-0': answer('contradicts'), 'finding-1': answer('unrelated') },
      input,
      {},
      ctx,
    );
    expect(out.kind).toBe('escalate');
    if (out.kind !== 'escalate') return;
    expect(out.partial?.annotations?.map((a) => a.relation)).toEqual(['contradicts', 'unrelated']);
    expect(out.reason).toBe('2 review findings not supported by the cited code');
  });

  it('degrades a missing or unknown answer to cannot-tell and uses singular reason', () => {
    const one = { items: [item('finding-0'), item('finding-1')] };
    const out = findingGroundingJudgment.compose(
      { 'finding-0': answer('contradicts'), 'finding-1': answer('weird') },
      one,
      {},
      ctx,
    );
    if (out.kind !== 'escalate') throw new Error('expected escalate');
    expect(out.partial?.annotations?.[1].relation).toBe('cannot-tell');
    expect(out.reason).toBe('1 review finding not supported by the cited code');
    const none = findingGroundingJudgment.compose({}, { items: [item('finding-0')] }, {}, ctx);
    expect(none).toMatchObject({ kind: 'act' });
  });
});
