/**
 * Tests for the Phase 4 auto-pass dispatcher (RFC-0011 §6.4 + AISDLC-115.5).
 *
 * Covers:
 *   - First-match-wins ordering across multiple rules
 *   - `sources` predicate (must contain author identity)
 *   - Optional `titlePattern` regex predicate
 *   - Optional `maxBodyDiffLines` cap predicate
 *   - `gatesSkipped` direct shape
 *   - `gatesRetained` inverse shape (skip = ALL_GATES \ retained)
 *   - Legacy "both empty" → skip every gate
 *   - Invalid regex / missing author / no-match → empty skip set
 *   - SIGNAL_PIPELINE_AUTOPASS_RULE constant matches Alex's Addition 1
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_GATES,
  applyAutoPass,
  resolveGatesSkipped,
  SIGNAL_PIPELINE_AUTOPASS_RULE,
} from './auto-pass.js';
import type { AutoPassRule } from './dor-config.js';
import type { IssueInput } from './types.js';

function input(overrides: Partial<IssueInput> = {}): IssueInput {
  return {
    source: 'backlog',
    id: 'AISDLC-1',
    title: 'A task',
    body: 'body',
    authorIdentity: 'ai-sdlc/signal-pipeline',
    ...overrides,
  };
}

describe('applyAutoPass — matching predicates', () => {
  it('returns empty skip set when no rules are configured', () => {
    const out = applyAutoPass(input(), []);
    expect(out.matched).toBeUndefined();
    expect(out.gatesSkipped).toEqual([]);
  });

  it('returns empty skip set when authorIdentity does not match any source', () => {
    const out = applyAutoPass(input({ authorIdentity: 'someone-else' }), [
      SIGNAL_PIPELINE_AUTOPASS_RULE,
    ]);
    expect(out.matched).toBeUndefined();
    expect(out.gatesSkipped).toEqual([]);
  });

  it('returns empty skip set when issue has no authorIdentity', () => {
    const out = applyAutoPass(input({ authorIdentity: undefined }), [
      SIGNAL_PIPELINE_AUTOPASS_RULE,
    ]);
    expect(out.gatesSkipped).toEqual([]);
  });

  it('matches when authorIdentity is in sources list', () => {
    const out = applyAutoPass(input(), [SIGNAL_PIPELINE_AUTOPASS_RULE]);
    expect(out.matched?.kind).toBe('signal-pipeline-generated');
    expect(out.gatesSkipped).toEqual([1, 4, 5, 6]);
  });

  it('first-match-wins across multiple rules', () => {
    const ruleA: AutoPassRule = {
      kind: 'first-match',
      sources: ['ai-sdlc/signal-pipeline'],
      gatesSkipped: [1],
      gatesRetained: [],
    };
    const ruleB: AutoPassRule = {
      kind: 'second-match',
      sources: ['ai-sdlc/signal-pipeline'],
      gatesSkipped: [2, 3],
      gatesRetained: [],
    };
    const out = applyAutoPass(input(), [ruleA, ruleB]);
    expect(out.matched?.kind).toBe('first-match');
    expect(out.gatesSkipped).toEqual([1]);
  });
});

describe('applyAutoPass — titlePattern', () => {
  const rule: AutoPassRule = {
    kind: 'doc-typo',
    sources: ['somebot'],
    titlePattern: '^docs:\\s+typo',
    gatesSkipped: [1, 2, 3, 4, 5, 6, 7],
    gatesRetained: [],
  };

  it('matches when titlePattern matches', () => {
    const out = applyAutoPass(input({ authorIdentity: 'somebot', title: 'docs: typo in README' }), [
      rule,
    ]);
    expect(out.matched?.kind).toBe('doc-typo');
  });

  it('does not match when titlePattern fails', () => {
    const out = applyAutoPass(input({ authorIdentity: 'somebot', title: 'feat: new thing' }), [
      rule,
    ]);
    expect(out.matched).toBeUndefined();
  });

  it('fail-closed when titlePattern is invalid regex', () => {
    const bad: AutoPassRule = { ...rule, titlePattern: '([unclosed' };
    const out = applyAutoPass(input({ authorIdentity: 'somebot' }), [bad]);
    expect(out.matched).toBeUndefined();
    expect(out.gatesSkipped).toEqual([]);
  });
});

describe('applyAutoPass — maxBodyDiffLines', () => {
  const rule: AutoPassRule = {
    kind: 'small-doc',
    sources: ['author'],
    maxBodyDiffLines: 5,
    gatesSkipped: [1],
    gatesRetained: [],
  };

  it('matches when body line count is at or under cap', () => {
    const out = applyAutoPass(input({ authorIdentity: 'author', body: 'a\nb\nc' }), [rule]);
    expect(out.matched?.kind).toBe('small-doc');
  });

  it('rejects when body line count exceeds cap', () => {
    const big = Array(20).fill('line').join('\n');
    const out = applyAutoPass(input({ authorIdentity: 'author', body: big }), [rule]);
    expect(out.matched).toBeUndefined();
  });
});

describe('resolveGatesSkipped', () => {
  it('returns gatesSkipped verbatim when set', () => {
    const r: AutoPassRule = {
      kind: 'k',
      sources: ['s'],
      gatesSkipped: [2, 5],
      gatesRetained: [],
    };
    expect(resolveGatesSkipped(r)).toEqual([2, 5]);
  });

  it('inverts gatesRetained when gatesSkipped is empty', () => {
    const r: AutoPassRule = {
      kind: 'k',
      sources: ['s'],
      gatesSkipped: [],
      gatesRetained: [2, 3, 7],
    };
    // Skip = ALL_GATES minus retained = [1, 4, 5, 6]
    expect(resolveGatesSkipped(r)).toEqual([1, 4, 5, 6]);
  });

  it('skips every gate when both arrays are empty (legacy shortcut)', () => {
    const r: AutoPassRule = {
      kind: 'k',
      sources: ['s'],
      gatesSkipped: [],
      gatesRetained: [],
    };
    expect(resolveGatesSkipped(r)).toEqual(ALL_GATES);
  });

  it('drops out-of-range gates from gatesSkipped', () => {
    const r: AutoPassRule = {
      kind: 'k',
      sources: ['s'],
      gatesSkipped: [0, 1, 8, 5],
      gatesRetained: [],
    };
    expect(resolveGatesSkipped(r)).toEqual([1, 5]);
  });

  it('dedupes gatesSkipped entries', () => {
    const r: AutoPassRule = {
      kind: 'k',
      sources: ['s'],
      gatesSkipped: [3, 3, 3],
      gatesRetained: [],
    };
    expect(resolveGatesSkipped(r)).toEqual([3]);
  });
});

describe('SIGNAL_PIPELINE_AUTOPASS_RULE', () => {
  it("matches Alex's Addition 1: skip 1/4/5/6, retain 2/3/7", () => {
    expect(SIGNAL_PIPELINE_AUTOPASS_RULE.kind).toBe('signal-pipeline-generated');
    expect(SIGNAL_PIPELINE_AUTOPASS_RULE.sources).toEqual(['ai-sdlc/signal-pipeline']);
    expect(SIGNAL_PIPELINE_AUTOPASS_RULE.gatesSkipped).toEqual([1, 4, 5, 6]);
    expect(SIGNAL_PIPELINE_AUTOPASS_RULE.gatesRetained).toEqual([2, 3, 7]);
  });
});
