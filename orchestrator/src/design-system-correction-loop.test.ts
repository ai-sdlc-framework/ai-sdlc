import { describe, it, expect } from 'vitest';
import {
  checkExitConditions,
  runCorrectionLoop,
  createDesignReviewFeedbackStore,
  type CorrectionIteration,
  type CorrectionLoopConfig,
} from './design-system-correction-loop.js';
import type { VisualRegressionFailure } from '@ai-sdlc/reference';

const sampleFailure: VisualRegressionFailure = {
  componentName: 'Button',
  storyName: 'Button/Default',
  viewport: 1280,
  diffPercentage: 0.05,
  changedRegions: [{ x: 0, y: 0, width: 100, height: 50 }],
  affectedTokens: ['color.primary'],
  baselineUrl: 'file://baseline.png',
  currentUrl: 'file://current.png',
};

function makeIteration(overrides: Partial<CorrectionIteration> = {}): CorrectionIteration {
  return {
    attempt: 0,
    failures: [sampleFailure],
    costUsd: 0.1,
    tokenReferencesChanged: false,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('checkExitConditions', () => {
  const config: CorrectionLoopConfig = { maxRetries: 3, costSoftLimitUsd: 0.5 };

  it('returns null when no conditions met', () => {
    const result = checkExitConditions([makeIteration()], config, false);
    expect(result).toBeNull();
  });

  it('returns max-retries when limit reached', () => {
    const iterations = [makeIteration(), makeIteration(), makeIteration()];
    expect(checkExitConditions(iterations, config, false)).toBe('max-retries');
  });

  it('returns token-reference-changed', () => {
    const iterations = [makeIteration({ tokenReferencesChanged: true })];
    expect(checkExitConditions(iterations, config, false)).toBe('token-reference-changed');
  });

  it('returns cost-limit-exceeded', () => {
    const iterations = [makeIteration({ costUsd: 0.2 }), makeIteration({ costUsd: 0.4 })];
    expect(checkExitConditions(iterations, config, false)).toBe('cost-limit-exceeded');
  });

  it('returns design-review-triggered', () => {
    expect(checkExitConditions([makeIteration()], config, true)).toBe('design-review-triggered');
  });
});

describe('runCorrectionLoop', () => {
  it('converges when agent fixes all failures', async () => {
    let attempt = 0;
    const result = await runCorrectionLoop(
      async () => ({
        failures: attempt++ === 0 ? [sampleFailure] : [],
        costUsd: 0.1,
        tokenReferencesChanged: false,
      }),
      { maxRetries: 5, costSoftLimitUsd: 1.0 },
    );
    expect(result.converged).toBe(true);
    expect(result.exitReason).toBe('success');
    expect(result.iterations).toHaveLength(2);
  });

  it('exits on max retries', async () => {
    const result = await runCorrectionLoop(
      async () => ({
        failures: [sampleFailure],
        costUsd: 0.05,
        tokenReferencesChanged: false,
      }),
      { maxRetries: 2, costSoftLimitUsd: 10 },
    );
    expect(result.converged).toBe(false);
    expect(result.exitReason).toBe('max-retries');
    expect(result.iterations).toHaveLength(2);
  });

  it('exits when token references are changed', async () => {
    let attempt = 0;
    const result = await runCorrectionLoop(
      async () => ({
        failures: [sampleFailure],
        costUsd: 0.1,
        tokenReferencesChanged: attempt++ > 0, // changed on second attempt
      }),
      { maxRetries: 5, costSoftLimitUsd: 10 },
    );
    expect(result.converged).toBe(false);
    expect(result.exitReason).toBe('token-reference-changed');
  });

  it('exits when cost limit exceeded', async () => {
    const result = await runCorrectionLoop(
      async () => ({
        failures: [sampleFailure],
        costUsd: 0.3,
        tokenReferencesChanged: false,
      }),
      { maxRetries: 10, costSoftLimitUsd: 0.5 },
    );
    expect(result.converged).toBe(false);
    expect(result.exitReason).toBe('cost-limit-exceeded');
    expect(result.totalCostUsd).toBeGreaterThanOrEqual(0.5);
  });

  it('exits when design review triggered', async () => {
    let attempt = 0;
    const result = await runCorrectionLoop(
      async () => ({
        failures: [sampleFailure],
        costUsd: 0.1,
        tokenReferencesChanged: false,
      }),
      { maxRetries: 10, costSoftLimitUsd: 10 },
      () => attempt++ > 0, // triggered after first attempt
    );
    expect(result.converged).toBe(false);
    expect(result.exitReason).toBe('design-review-triggered');
  });

  it('tracks iteration history', async () => {
    const result = await runCorrectionLoop(
      async (_failures, attempt) => ({
        failures: attempt < 2 ? [sampleFailure] : [],
        costUsd: 0.1,
        tokenReferencesChanged: false,
        codeDiff: `diff-${attempt}`,
      }),
      { maxRetries: 5, costSoftLimitUsd: 10 },
    );
    expect(result.iterations).toHaveLength(3);
    expect(result.iterations[0].codeDiff).toBe('diff-0');
    expect(result.iterations[2].failures).toHaveLength(0);
  });
});

describe('DesignReviewFeedbackStore', () => {
  it('records entries', () => {
    const store = createDesignReviewFeedbackStore();
    store.record({
      prNumber: 1,
      category: 'visual-quality',
      signal: 'accepted',
      reviewer: 'design-lead',
      timestamp: new Date().toISOString(),
    });
    expect(store.getEntries()).toHaveLength(1);
  });

  it('computes precision', () => {
    const store = createDesignReviewFeedbackStore();
    const ts = new Date().toISOString();
    store.record({ prNumber: 1, category: 'a', signal: 'accepted', reviewer: 'r', timestamp: ts });
    store.record({ prNumber: 2, category: 'a', signal: 'accepted', reviewer: 'r', timestamp: ts });
    store.record({ prNumber: 3, category: 'b', signal: 'dismissed', reviewer: 'r', timestamp: ts });
    expect(store.precision()).toBeCloseTo(2 / 3);
  });

  it('returns 1.0 precision when no entries', () => {
    expect(createDesignReviewFeedbackStore().precision()).toBe(1);
  });

  it('identifies high false-positive categories', () => {
    const store = createDesignReviewFeedbackStore();
    const ts = new Date().toISOString();
    store.record({
      prNumber: 1,
      category: 'spacing',
      signal: 'dismissed',
      reviewer: 'r',
      timestamp: ts,
    });
    store.record({
      prNumber: 2,
      category: 'spacing',
      signal: 'dismissed',
      reviewer: 'r',
      timestamp: ts,
    });
    store.record({
      prNumber: 3,
      category: 'color',
      signal: 'accepted',
      reviewer: 'r',
      timestamp: ts,
    });
    store.record({
      prNumber: 4,
      category: 'color',
      signal: 'dismissed',
      reviewer: 'r',
      timestamp: ts,
    });

    const fps = store.highFalsePositiveCategories();
    expect(fps[0].category).toBe('spacing');
    expect(fps[0].dismissRate).toBe(1.0);
    expect(fps[1].category).toBe('color');
    expect(fps[1].dismissRate).toBe(0.5);
  });

  it('identifies false negative categories', () => {
    const store = createDesignReviewFeedbackStore();
    const ts = new Date().toISOString();
    store.record({
      prNumber: 1,
      category: 'interaction',
      signal: 'escalated',
      reviewer: 'r',
      timestamp: ts,
    });
    store.record({
      prNumber: 2,
      category: 'interaction',
      signal: 'accepted',
      reviewer: 'r',
      timestamp: ts,
    });

    const fns = store.falseNegativeCategories();
    expect(fns).toHaveLength(1);
    expect(fns[0].category).toBe('interaction');
    expect(fns[0].dismissRate).toBe(0.5); // escalation rate
  });
});
