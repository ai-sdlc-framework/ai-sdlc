import { describe, it, expect, vi } from 'vitest';
import { metaReview, ReviewFeedbackStore } from './review-meta.js';
import type { ReviewVerdict, ReviewFinding } from './runners/review-agent.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'minor',
    message: 'test finding',
    confidence: 0.7,
    ...overrides,
  };
}

function makeVerdict(findings: ReviewFinding[], approved = true): ReviewVerdict {
  return { type: 'critic', approved, findings, summary: 'test' };
}

// ── metaReview ───────────────────────────────────────────────────────

describe('metaReview', () => {
  const principles = 'Evidence-first: trace code paths before flagging.';

  it('passes through high-confidence findings without LLM call', async () => {
    const callLLM = vi.fn();
    const verdict = makeVerdict([makeFinding({ confidence: 0.9, message: 'real bug' })]);

    const result = await metaReview(verdict, principles, callLLM);

    expect(callLLM).not.toHaveBeenCalled();
    expect(result.verdict.findings).toHaveLength(1);
    expect(result.suppressed).toBe(0);
  });

  it('returns as-is when no medium-confidence findings', async () => {
    const callLLM = vi.fn();
    const verdict = makeVerdict([
      makeFinding({ confidence: 0.85 }),
      makeFinding({ confidence: 0.95 }),
    ]);

    const result = await metaReview(verdict, principles, callLLM);

    expect(callLLM).not.toHaveBeenCalled();
    expect(result.decisions).toHaveLength(0);
  });

  it('calls LLM for medium-confidence findings', async () => {
    const callLLM = vi.fn().mockResolvedValue('{"keep": true, "reason": "looks legit"}');
    const verdict = makeVerdict([makeFinding({ confidence: 0.6, message: 'medium' })]);

    const result = await metaReview(verdict, principles, callLLM);

    expect(callLLM).toHaveBeenCalledOnce();
    expect(result.verdict.findings).toHaveLength(1);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].decision.keep).toBe(true);
  });

  it('suppresses findings when meta-review says drop', async () => {
    const callLLM = vi.fn().mockResolvedValue('{"keep": false, "reason": "false positive"}');
    const verdict = makeVerdict([makeFinding({ confidence: 0.6, message: 'noise' })]);

    const result = await metaReview(verdict, principles, callLLM);

    expect(result.verdict.findings).toHaveLength(0);
    expect(result.suppressed).toBe(1);
    expect(result.decisions[0].decision.keep).toBe(false);
  });

  it('adjusts severity when meta-review suggests downgrade', async () => {
    const callLLM = vi
      .fn()
      .mockResolvedValue('{"keep": true, "adjustedSeverity": "suggestion", "reason": "not major"}');
    const verdict = makeVerdict([makeFinding({ confidence: 0.6, severity: 'major' })]);

    const result = await metaReview(verdict, principles, callLLM);

    expect(result.verdict.findings[0].severity).toBe('suggestion');
  });

  it('keeps finding conservatively when meta-review LLM fails', async () => {
    const callLLM = vi.fn().mockRejectedValue(new Error('API error'));
    const verdict = makeVerdict([makeFinding({ confidence: 0.6, message: 'keep me' })]);

    const result = await metaReview(verdict, principles, callLLM);

    expect(result.verdict.findings).toHaveLength(1);
    expect(result.decisions[0].decision.reason).toContain('failed');
  });

  it('handles mix of high and medium confidence findings', async () => {
    const callLLM = vi.fn().mockResolvedValue('{"keep": false, "reason": "noise"}');
    const verdict = makeVerdict([
      makeFinding({ confidence: 0.9, message: 'high' }),
      makeFinding({ confidence: 0.6, message: 'medium-dropped' }),
      makeFinding({ confidence: 0.85, message: 'also high' }),
    ]);

    const result = await metaReview(verdict, principles, callLLM);

    expect(callLLM).toHaveBeenCalledOnce(); // only medium
    expect(result.verdict.findings).toHaveLength(2);
    expect(result.verdict.findings.map((f) => f.message)).toEqual(['high', 'also high']);
  });

  it('approves verdict when all findings are suppressed', async () => {
    const callLLM = vi.fn().mockResolvedValue('{"keep": false, "reason": "all noise"}');
    const verdict = makeVerdict(
      [makeFinding({ confidence: 0.6 }), makeFinding({ confidence: 0.7 })],
      false,
    );

    const result = await metaReview(verdict, principles, callLLM);

    expect(result.verdict.findings).toHaveLength(0);
    expect(result.verdict.approved).toBe(true);
  });

  it('treats findings without confidence as high-confidence (legacy)', async () => {
    const callLLM = vi.fn();
    const verdict = makeVerdict([makeFinding({ confidence: undefined, message: 'legacy' })]);

    const result = await metaReview(verdict, principles, callLLM);

    expect(callLLM).not.toHaveBeenCalled();
    expect(result.verdict.findings).toHaveLength(1);
  });

  it('handles LLM returning markdown-wrapped JSON', async () => {
    const callLLM = vi.fn().mockResolvedValue('```json\n{"keep": true, "reason": "valid"}\n```');
    const verdict = makeVerdict([makeFinding({ confidence: 0.6 })]);

    const result = await metaReview(verdict, principles, callLLM);

    expect(result.verdict.findings).toHaveLength(1);
  });
});

// ── ReviewFeedbackStore ──────────────────────────────────────────────

describe('ReviewFeedbackStore', () => {
  it('starts empty', () => {
    const store = new ReviewFeedbackStore();
    expect(store.getAll()).toHaveLength(0);
    expect(store.precision()).toBe(1.0);
  });

  it('records and retrieves feedback', () => {
    const store = new ReviewFeedbackStore();
    store.record({
      prNumber: 1,
      finding: makeFinding(),
      signal: 'accepted',
      timestamp: '2026-01-01T00:00:00Z',
    });

    expect(store.getAll()).toHaveLength(1);
  });

  it('computes precision correctly', () => {
    const store = new ReviewFeedbackStore();
    store.record({
      prNumber: 1,
      finding: makeFinding(),
      signal: 'accepted',
      timestamp: '2026-01-01',
    });
    store.record({
      prNumber: 2,
      finding: makeFinding(),
      signal: 'accepted',
      timestamp: '2026-01-02',
    });
    store.record({
      prNumber: 3,
      finding: makeFinding(),
      signal: 'dismissed',
      timestamp: '2026-01-03',
    });

    expect(store.precision()).toBeCloseTo(0.667, 2);
  });

  it('ignores "ignored" signals in precision', () => {
    const store = new ReviewFeedbackStore();
    store.record({
      prNumber: 1,
      finding: makeFinding(),
      signal: 'accepted',
      timestamp: '2026-01-01',
    });
    store.record({
      prNumber: 2,
      finding: makeFinding(),
      signal: 'ignored',
      timestamp: '2026-01-02',
    });

    expect(store.precision()).toBe(1.0); // 1 accepted, 0 dismissed
  });

  it('groups feedback by category', () => {
    const store = new ReviewFeedbackStore();
    store.record({
      prNumber: 1,
      finding: makeFinding({ category: 'security' }),
      signal: 'dismissed',
      timestamp: '2026-01-01',
    });
    store.record({
      prNumber: 2,
      finding: makeFinding({ category: 'security' }),
      signal: 'dismissed',
      timestamp: '2026-01-02',
    });
    store.record({
      prNumber: 3,
      finding: makeFinding({ category: 'logic-error' }),
      signal: 'accepted',
      timestamp: '2026-01-03',
    });

    const cats = store.byCategory();
    expect(cats['security'].dismissed).toBe(2);
    expect(cats['logic-error'].accepted).toBe(1);
  });

  it('identifies high false-positive categories', () => {
    const store = new ReviewFeedbackStore();
    // Security: 1 accepted, 3 dismissed = 75% FP rate
    for (let i = 0; i < 3; i++) {
      store.record({
        prNumber: i,
        finding: makeFinding({ category: 'security' }),
        signal: 'dismissed',
        timestamp: '2026-01-01',
      });
    }
    store.record({
      prNumber: 4,
      finding: makeFinding({ category: 'security' }),
      signal: 'accepted',
      timestamp: '2026-01-02',
    });

    // Logic: 3 accepted, 0 dismissed = 0% FP rate
    for (let i = 0; i < 3; i++) {
      store.record({
        prNumber: i + 10,
        finding: makeFinding({ category: 'logic-error' }),
        signal: 'accepted',
        timestamp: '2026-01-03',
      });
    }

    const highFP = store.highFalsePositiveCategories();
    expect(highFP).toContain('security');
    expect(highFP).not.toContain('logic-error');
  });

  it('requires minimum 3 samples before flagging high FP', () => {
    const store = new ReviewFeedbackStore();
    store.record({
      prNumber: 1,
      finding: makeFinding({ category: 'design' }),
      signal: 'dismissed',
      timestamp: '2026-01-01',
    });
    store.record({
      prNumber: 2,
      finding: makeFinding({ category: 'design' }),
      signal: 'dismissed',
      timestamp: '2026-01-02',
    });

    // Only 2 samples — not enough to flag
    expect(store.highFalsePositiveCategories()).not.toContain('design');
  });
});
