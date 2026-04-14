import { describe, it, expect } from 'vitest';
import {
  filterByConfidence,
  runMetaReview,
  createHeuristicMetaReviewer,
  CONFIDENCE_THRESHOLD,
  META_REVIEW_UPPER,
} from './meta-review.js';
import type { UsabilityFinding } from '../interfaces.js';

function makeFinding(overrides: Partial<UsabilityFinding> = {}): UsabilityFinding {
  return {
    severity: 'major',
    confidence: 0.7,
    category: 'discoverability',
    evidence: {
      taskAttempted: 'form-submission',
      personaProfile: 'low-tech',
      actionsTaken: 8,
      expectedActions: 5,
      failurePoint: 'submit button',
      failureScenario: 'User could not find the submit button below the fold on mobile viewport',
    },
    message: 'Submit button not discoverable',
    ...overrides,
  };
}

describe('filterByConfidence', () => {
  it('suppresses findings below threshold', () => {
    const findings = [
      makeFinding({ confidence: 0.3 }),
      makeFinding({ confidence: 0.6 }),
      makeFinding({ confidence: 0.9 }),
    ];
    const result = filterByConfidence(findings);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0].confidence).toBe(0.3);
  });

  it('sends medium-confidence to meta-review', () => {
    const findings = [makeFinding({ confidence: 0.6 }), makeFinding({ confidence: 0.7 })];
    const result = filterByConfidence(findings);
    expect(result.needsMetaReview).toHaveLength(2);
    expect(result.kept).toHaveLength(0);
  });

  it('keeps high-confidence findings', () => {
    const findings = [makeFinding({ confidence: 0.85 }), makeFinding({ confidence: 0.95 })];
    const result = filterByConfidence(findings);
    expect(result.kept).toHaveLength(2);
    expect(result.needsMetaReview).toHaveLength(0);
  });

  it('uses correct thresholds', () => {
    expect(CONFIDENCE_THRESHOLD).toBe(0.5);
    expect(META_REVIEW_UPPER).toBe(0.8);
  });
});

describe('createHeuristicMetaReviewer', () => {
  it('keeps findings with failure point and detailed scenario', async () => {
    const reviewer = createHeuristicMetaReviewer();
    const finding = makeFinding({
      confidence: 0.6,
      evidence: {
        taskAttempted: 'form',
        personaProfile: 'low-tech',
        actionsTaken: 10,
        expectedActions: 5,
        failurePoint: 'submit button',
        failureScenario: 'User scrolled past the submit button three times without noticing it',
      },
    });
    const review = await reviewer.evaluate(finding);
    expect(review.decision).toBe('keep');
  });

  it('suppresses findings with weak evidence', async () => {
    const reviewer = createHeuristicMetaReviewer();
    const finding = makeFinding({
      confidence: 0.55,
      evidence: {
        taskAttempted: 'nav',
        personaProfile: 'high-tech',
        actionsTaken: 4,
        expectedActions: 3,
        failureScenario: 'Minor issue',
      },
    });
    const review = await reviewer.evaluate(finding);
    expect(review.decision).toBe('suppress');
  });

  it('downgrades severity for high action delta without failure point', async () => {
    const reviewer = createHeuristicMetaReviewer();
    const finding = makeFinding({
      confidence: 0.65,
      evidence: {
        taskAttempted: 'form',
        personaProfile: 'low-tech',
        actionsTaken: 15,
        expectedActions: 5,
        failureScenario: 'Agent took many extra steps trying to find the submit action in the form',
      },
    });
    const review = await reviewer.evaluate(finding);
    expect(review.decision).toBe('keep');
    expect(review.adjustedSeverity).toBe('minor');
  });
});

describe('runMetaReview', () => {
  it('processes all findings through evaluator', async () => {
    const findings = [
      makeFinding({ confidence: 0.6 }),
      makeFinding({
        confidence: 0.55,
        evidence: {
          taskAttempted: 'x',
          personaProfile: 'y',
          actionsTaken: 3,
          expectedActions: 3,
          failureScenario: 'Short',
        },
      }),
    ];
    const reviewer = createHeuristicMetaReviewer();
    const result = await runMetaReview(findings, reviewer);
    expect(result.reviews).toHaveLength(2);
    expect(result.kept.length + result.suppressed.length).toBe(2);
  });

  it('applies adjusted severity to kept findings', async () => {
    const finding = makeFinding({
      severity: 'major',
      confidence: 0.65,
      evidence: {
        taskAttempted: 'form',
        personaProfile: 'low-tech',
        actionsTaken: 15,
        expectedActions: 5,
        failureScenario: 'Agent took many extra steps trying to find the submit action in the form',
      },
    });
    const reviewer = createHeuristicMetaReviewer();
    const result = await runMetaReview([finding], reviewer);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].severity).toBe('minor'); // downgraded
  });
});
