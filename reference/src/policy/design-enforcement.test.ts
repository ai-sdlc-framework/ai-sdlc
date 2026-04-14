import { describe, it, expect } from 'vitest';
import { evaluateGate } from './enforcement.js';
import type { Gate } from '../core/types.js';
import type { EvaluationContext } from './enforcement.js';

function baseCtx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    authorType: 'ai-agent',
    repository: 'org/repo',
    metrics: {},
    ...overrides,
  };
}

describe('designTokenCompliance rule', () => {
  const gate: Gate = {
    name: 'no-hardcoded-colors',
    enforcement: 'hard-mandatory',
    rule: {
      designTokenCompliance: true,
      designSystem: 'acme-ds',
      category: 'color',
      maxViolations: 0,
    },
  };

  it('passes when no violations', () => {
    const ctx = baseCtx({ designTokenViolations: { color: 0 } });
    const result = evaluateGate(gate, ctx);
    expect(result.verdict).toBe('pass');
  });

  it('fails when violations exceed max', () => {
    const ctx = baseCtx({ designTokenViolations: { color: 3 } });
    const result = evaluateGate(gate, ctx);
    expect(result.verdict).toBe('fail');
    expect(result.message).toContain('3');
    expect(result.message).toContain('color');
  });

  it('passes with violations below max', () => {
    const gateWithMax: Gate = {
      ...gate,
      rule: { ...gate.rule, maxViolations: 5 } as Gate['rule'],
    };
    const ctx = baseCtx({ designTokenViolations: { color: 3 } });
    const result = evaluateGate(gateWithMax, ctx);
    expect(result.verdict).toBe('pass');
  });

  it('evaluates coverage metric mode', () => {
    const coverageGate: Gate = {
      name: 'token-coverage',
      enforcement: 'advisory',
      rule: {
        designTokenCompliance: true,
        designSystem: 'acme-ds',
        coverageMetric: { operator: '>=', threshold: 85 },
      },
    };
    const passCtx = baseCtx({ metrics: { 'token-coverage': 91 } });
    expect(evaluateGate(coverageGate, passCtx).verdict).toBe('pass');

    const failCtx = baseCtx({ metrics: { 'token-coverage': 70 } });
    // advisory enforcement — still reported as pass (allowed)
    const result = evaluateGate(coverageGate, failCtx);
    expect(result.verdict).toBe('fail');
    expect(result.message).toContain('70');
  });

  it('falls back to metrics when designTokenViolations not set', () => {
    const ctx = baseCtx({ metrics: { 'color-violations': 2 } });
    const result = evaluateGate(gate, ctx);
    expect(result.verdict).toBe('fail');
  });
});

describe('visualRegression rule', () => {
  const gate: Gate = {
    name: 'visual-diff',
    enforcement: 'soft-mandatory',
    rule: {
      visualRegression: true,
      designSystem: 'acme-ds',
      config: { diffThreshold: 0.01, requireBaseline: true },
    },
  };

  it('passes when diff is within threshold', () => {
    const ctx = baseCtx({
      metrics: { 'visual-diff-percentage': 0.005, 'baseline-exists': 1 },
    });
    expect(evaluateGate(gate, ctx).verdict).toBe('pass');
  });

  it('fails when diff exceeds threshold', () => {
    const ctx = baseCtx({
      metrics: { 'visual-diff-percentage': 0.05, 'baseline-exists': 1 },
    });
    const result = evaluateGate(gate, ctx);
    expect(result.verdict).toBe('fail');
    expect(result.message).toContain('5.0%');
    expect(result.message).toContain('1.0%');
  });

  it('fails when baseline missing and required', () => {
    const ctx = baseCtx({
      metrics: { 'visual-diff-percentage': 0, 'baseline-exists': 0 },
    });
    const result = evaluateGate(gate, ctx);
    expect(result.verdict).toBe('fail');
    expect(result.message).toContain('baseline');
  });

  it('supports soft-mandatory override', () => {
    const gateWithOverride: Gate = {
      ...gate,
      override: { requiredRole: 'design-lead' },
    };
    const ctx = baseCtx({
      metrics: { 'visual-diff-percentage': 0.05, 'baseline-exists': 1 },
      overrideRole: 'design-lead',
    });
    expect(evaluateGate(gateWithOverride, ctx).verdict).toBe('override');
  });
});

describe('storyCompleteness rule', () => {
  const gate: Gate = {
    name: 'story-exists',
    enforcement: 'hard-mandatory',
    rule: {
      storyCompleteness: true,
      config: {
        requireDefaultStory: true,
        requireStateStories: true,
        requireA11yStory: true,
        minStories: 3,
      },
    },
  };

  it('passes when all requirements met', () => {
    const ctx = baseCtx({
      storyMeta: {
        hasDefaultStory: true,
        hasStateStories: true,
        hasA11yStory: true,
        storyCount: 5,
      },
    });
    expect(evaluateGate(gate, ctx).verdict).toBe('pass');
  });

  it('fails when default story missing', () => {
    const ctx = baseCtx({
      storyMeta: {
        hasDefaultStory: false,
        hasStateStories: true,
        hasA11yStory: true,
        storyCount: 3,
      },
    });
    const result = evaluateGate(gate, ctx);
    expect(result.verdict).toBe('fail');
    expect(result.message).toContain('Default story');
  });

  it('fails when story count below minimum', () => {
    const ctx = baseCtx({
      storyMeta: {
        hasDefaultStory: true,
        hasStateStories: true,
        hasA11yStory: true,
        storyCount: 1,
      },
    });
    const result = evaluateGate(gate, ctx);
    expect(result.verdict).toBe('fail');
    expect(result.message).toContain('1');
    expect(result.message).toContain('3');
  });

  it('fails when storyMeta not provided', () => {
    const ctx = baseCtx();
    const result = evaluateGate(gate, ctx);
    expect(result.verdict).toBe('fail');
    expect(result.message).toContain('metadata not available');
  });
});

describe('designReview rule', () => {
  const gate: Gate = {
    name: 'design-quality',
    enforcement: 'hard-mandatory',
    rule: {
      designReview: true,
      designSystem: 'acme-ds',
      reviewers: ['design-lead'],
      onTimeout: 'pause',
    },
  };

  it('passes when review approved', () => {
    const ctx = baseCtx({
      designReview: { decision: 'approved', reviewer: 'design-lead' },
    });
    expect(evaluateGate(gate, ctx).verdict).toBe('pass');
  });

  it('passes when approved-with-comments', () => {
    const ctx = baseCtx({
      designReview: { decision: 'approved-with-comments', reviewer: 'design-lead' },
    });
    expect(evaluateGate(gate, ctx).verdict).toBe('pass');
  });

  it('fails when review rejected', () => {
    const ctx = baseCtx({
      designReview: { decision: 'rejected', reviewer: 'design-lead' },
    });
    const result = evaluateGate(gate, ctx);
    expect(result.verdict).toBe('fail');
    expect(result.message).toContain('rejected');
  });

  it('fails when review not submitted', () => {
    const ctx = baseCtx();
    const result = evaluateGate(gate, ctx);
    expect(result.verdict).toBe('fail');
    expect(result.message).toContain('not yet submitted');
  });

  it('fails with pause message on timeout when onTimeout=pause', () => {
    const ctx = baseCtx({
      designReview: { pendingTimeout: true },
    });
    const result = evaluateGate(gate, ctx);
    expect(result.verdict).toBe('fail');
    expect(result.message).toContain('paused');
  });

  it('fails with timeout message when onTimeout=fail', () => {
    const failGate: Gate = {
      ...gate,
      rule: { ...gate.rule, onTimeout: 'fail' } as Gate['rule'],
    };
    const ctx = baseCtx({
      designReview: { pendingTimeout: true },
    });
    const result = evaluateGate(failGate, ctx);
    expect(result.verdict).toBe('fail');
    expect(result.message).toContain('timed out');
  });
});
