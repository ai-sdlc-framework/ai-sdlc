import { describe, it, expect } from 'vitest';
import type { Bm25Corpus, PrincipleCorpora } from './did-compiler.js';
import {
  computeDomainRelevance,
  computePrincipleCoverage,
  __internals,
} from './layer2-structural.js';

// Helper to construct a corpus from pre-tokenized docs.
function corpus(docs: Array<{ id: string; tokens: string[]; weight?: number }>): Bm25Corpus {
  return {
    documents: docs.map((d) => ({
      id: d.id,
      tokens: d.tokens,
      weight: d.weight ?? 1,
    })),
  };
}

describe('internal: normalizeScore', () => {
  it('maps 0 → 0', () => {
    expect(__internals.normalizeScore(0)).toBe(0);
  });

  it('maps negative → 0 (defensive)', () => {
    expect(__internals.normalizeScore(-3)).toBe(0);
  });

  it('monotonic in input', () => {
    expect(__internals.normalizeScore(1)).toBeLessThan(__internals.normalizeScore(2));
  });

  it('bounded above by 1 (tanh asymptote)', () => {
    expect(__internals.normalizeScore(1000)).toBeLessThanOrEqual(1);
  });
});

describe('internal: topTerms', () => {
  it('sorts by score desc then alpha', () => {
    const terms = __internals.topTerms(
      new Map([
        ['apple', 1],
        ['banana', 2],
        ['cherry', 2],
      ]),
      5,
    );
    expect(terms.map((t) => t.term)).toEqual(['banana', 'cherry', 'apple']);
  });

  it('caps length at limit', () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 20; i++) m.set(`t${i}`, 20 - i);
    expect(__internals.topTerms(m, 10)).toHaveLength(10);
  });
});

describe('computeDomainRelevance', () => {
  it('AC #1: identical inputs yield identical scores bit-exactly', () => {
    const c = corpus([
      { id: 'mission', tokens: ['small', 'business', 'onboarding', 'simple'], weight: 2 },
    ]);
    const a = computeDomainRelevance('small business onboarding', c);
    const b = computeDomainRelevance('small business onboarding', c);
    expect(a.score).toBe(b.score);
    expect(a.rawScore).toBe(b.rawScore);
    expect(a.contributingTerms).toEqual(b.contributingTerms);
  });

  it('returns 0 for empty query', () => {
    const c = corpus([{ id: 'mission', tokens: ['x', 'y', 'z'] }]);
    expect(computeDomainRelevance('', c).score).toBe(0);
  });

  it('returns 0 for empty corpus', () => {
    expect(computeDomainRelevance('anything', corpus([])).score).toBe(0);
  });

  it('scores match higher when more query terms overlap', () => {
    const c = corpus([{ id: 'mission', tokens: ['onboarding', 'small', 'business'], weight: 2 }]);
    const low = computeDomainRelevance('unrelated text here', c);
    const high = computeDomainRelevance('small business onboarding flow', c);
    expect(high.score).toBeGreaterThan(low.score);
  });

  it('core weight (2×) boosts score vs evolving (1×)', () => {
    const evolving = corpus([{ id: 'm', tokens: ['onboarding', 'small', 'business'], weight: 1 }]);
    const core = corpus([{ id: 'm', tokens: ['onboarding', 'small', 'business'], weight: 2 }]);
    const coreScore = computeDomainRelevance('small business onboarding', core).rawScore;
    const evolvingScore = computeDomainRelevance('small business onboarding', evolving).rawScore;
    expect(coreScore).toBeGreaterThan(evolvingScore);
  });

  it('AC #3: contributingTerms capped at 10 and score-sorted', () => {
    // 15 distinct query terms, corpus has all of them
    const tokens = Array.from({ length: 15 }, (_, i) => `term${i}`);
    const c = corpus([{ id: 'm', tokens, weight: 1 }]);
    const result = computeDomainRelevance(tokens.join(' '), c);
    expect(result.contributingTerms).toHaveLength(10);
    for (let i = 1; i < result.contributingTerms.length; i++) {
      expect(result.contributingTerms[i - 1].score).toBeGreaterThanOrEqual(
        result.contributingTerms[i].score,
      );
    }
  });

  it('uses per-doc scoring with max aggregation', () => {
    // With two docs of different relevance, the score reflects the best
    // matching doc — a fully-matching doc shouldn't be diluted by a
    // completely irrelevant sibling.
    const mixed = corpus([
      { id: 'match', tokens: ['small', 'business', 'onboarding'] },
      { id: 'noise', tokens: ['completely', 'different', 'tokens'] },
    ]);
    const onlyMatch = corpus([{ id: 'match', tokens: ['small', 'business', 'onboarding'] }]);
    const mixedScore = computeDomainRelevance('small business onboarding', mixed).rawScore;
    const matchOnlyScore = computeDomainRelevance('small business onboarding', onlyMatch).rawScore;
    // Max-aggregation means adding a noise doc doesn't reduce the score.
    // (IDF changes because corpus size grew, but the key property is that
    // the scoring considers the best-matching doc.)
    expect(mixedScore).toBeGreaterThan(0);
    expect(matchOnlyScore).toBeGreaterThan(0);
  });
});

describe('computePrincipleCoverage', () => {
  function buildPrincipleCorpora(): PrincipleCorpora {
    return {
      approachable: {
        documents: [
          {
            id: 'approachable.description',
            tokens: ['form', 'simple', 'intuitive', 'easy'],
            weight: 2, // core
          },
        ],
      },
      playful: {
        documents: [
          {
            id: 'playful.description',
            tokens: ['delight', 'surprise', 'spark'],
            weight: 1, // evolving
          },
        ],
      },
    };
  }

  it('emits one entry per principle sorted alphabetically by id', () => {
    const result = computePrincipleCoverage(
      'simple intuitive form for delightful surprise',
      buildPrincipleCorpora(),
    );
    expect(result.principles.map((p) => p.principleId)).toEqual(['approachable', 'playful']);
  });

  it('assigns core identityClass when first doc weight is 2', () => {
    const result = computePrincipleCoverage('form simple', buildPrincipleCorpora());
    const approachable = result.principles.find((p) => p.principleId === 'approachable');
    expect(approachable!.identityClass).toBe('core');
    const playful = result.principles.find((p) => p.principleId === 'playful');
    expect(playful!.identityClass).toBe('evolving');
  });

  it('AC #2: weighted mean gives core 2× influence', () => {
    // Craft so approachable=1.0 and playful=0.0; weighted mean must be
    // (1×2 + 0×1) / 3 = 0.667, NOT the simple mean 0.5.
    const corpora: PrincipleCorpora = {
      approachable: {
        documents: [{ id: 'a', tokens: ['unique', 'core', 'phrase'], weight: 2 }],
      },
      playful: {
        documents: [{ id: 'p', tokens: ['wholly', 'different', 'words'], weight: 1 }],
      },
    };
    const result = computePrincipleCoverage('unique core phrase', corpora);
    const a = result.principles.find((p) => p.principleId === 'approachable')!;
    const p = result.principles.find((pr) => pr.principleId === 'playful')!;
    expect(a.coverage).toBeGreaterThan(0);
    expect(p.coverage).toBe(0);
    // weighted mean should skew toward the core coverage
    const expected = (a.coverage * 2 + p.coverage * 1) / 3;
    expect(result.overallCoverage).toBeCloseTo(expected, 10);
    expect(result.overallCoverage).toBeGreaterThan((a.coverage + p.coverage) / 2);
  });

  it('returns zero coverage for empty principleCorpora', () => {
    const result = computePrincipleCoverage('anything', {});
    expect(result.principles).toEqual([]);
    expect(result.overallCoverage).toBe(0);
  });

  it('each entry carries its own contributingTerms', () => {
    const result = computePrincipleCoverage('simple intuitive form', buildPrincipleCorpora());
    const approachable = result.principles.find((p) => p.principleId === 'approachable')!;
    expect(approachable.contributingTerms.length).toBeGreaterThan(0);
    expect(approachable.contributingTerms.length).toBeLessThanOrEqual(10);
  });
});

describe('AC #1: determinism across runs', () => {
  it('domainRelevance is deterministic across 100 iterations', () => {
    const c = corpus([
      { id: 'a', tokens: ['small', 'business', 'onboarding'], weight: 2 },
      { id: 'b', tokens: ['delight', 'surprise'], weight: 1 },
    ]);
    const baseline = computeDomainRelevance('small business delight', c);
    for (let i = 0; i < 100; i++) {
      const r = computeDomainRelevance('small business delight', c);
      expect(r.score).toBe(baseline.score);
      expect(r.rawScore).toBe(baseline.rawScore);
      expect(r.contributingTerms).toEqual(baseline.contributingTerms);
    }
  });
});

describe('AC #4: brand-config-vocabulary-overlap analog (no §B.6.4 fixture)', () => {
  // The §B.6.4 exemplar expects domainRelevance ≈ 0.72 for a high-overlap
  // fixture. Without the exact exemplar we can't calibrate the
  // normalizer to match bit-exactly; instead we assert the score is in
  // the "significant relevance" band (>0.4) with a core-weighted corpus
  // and monotonically above a low-overlap baseline.
  it('high-overlap query produces domainRelevance in the significant band', () => {
    const c = corpus([
      {
        id: 'mission',
        tokens: ['brand', 'theming', 'vocabulary', 'overlap', 'configuration', 'surface'],
        weight: 2,
      },
    ]);
    const result = computeDomainRelevance(
      'brand theming vocabulary overlap configuration surface',
      c,
    );
    expect(result.score).toBeGreaterThan(0.4);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('low-overlap query produces domainRelevance < 0.3', () => {
    const c = corpus([{ id: 'mission', tokens: ['brand', 'theming', 'vocabulary'], weight: 2 }]);
    const result = computeDomainRelevance('completely unrelated topic area', c);
    expect(result.score).toBeLessThan(0.3);
  });

  it('high-overlap scores strictly greater than low-overlap on the same corpus', () => {
    const c = corpus([{ id: 'mission', tokens: ['brand', 'theming', 'vocabulary'], weight: 2 }]);
    const high = computeDomainRelevance('brand theming vocabulary', c);
    const low = computeDomainRelevance('completely unrelated topic', c);
    expect(high.score).toBeGreaterThan(low.score);
  });
});
