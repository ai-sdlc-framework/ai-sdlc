import { describe, it, expect } from 'vitest';
import {
  computeDesignReviewApprovalRate,
  computeDesignReviewFirstPassRate,
  computeUsabilitySimulationPassRate,
  computeTokenComplianceTrend,
  computeVisualRegressionPassRate,
  computeDesignMetrics,
} from './design-system-metrics.js';
import type {
  DesignReviewEventRecord,
  UsabilitySimulationResultRecord,
  VisualRegressionResultRecord,
} from './state/types.js';

const ts = '2026-04-13T00:00:00Z';

describe('computeDesignReviewApprovalRate', () => {
  it('returns 1 for no events', () => {
    expect(computeDesignReviewApprovalRate([])).toBe(1);
  });

  it('computes approval rate', () => {
    const events: DesignReviewEventRecord[] = [
      { bindingName: 'ds', reviewer: 'r', decision: 'approved', createdAt: ts },
      { bindingName: 'ds', reviewer: 'r', decision: 'approved-with-comments', createdAt: ts },
      { bindingName: 'ds', reviewer: 'r', decision: 'rejected', createdAt: ts },
    ];
    expect(computeDesignReviewApprovalRate(events)).toBeCloseTo(2 / 3);
  });
});

describe('computeDesignReviewFirstPassRate', () => {
  it('returns 1 for no events', () => {
    expect(computeDesignReviewFirstPassRate([])).toBe(1);
  });

  it('computes first-pass rate grouped by PR', () => {
    const events: DesignReviewEventRecord[] = [
      {
        bindingName: 'ds',
        prNumber: 1,
        reviewer: 'r',
        decision: 'approved',
        createdAt: '2026-01-01',
      },
      {
        bindingName: 'ds',
        prNumber: 2,
        reviewer: 'r',
        decision: 'rejected',
        createdAt: '2026-01-01',
      },
      {
        bindingName: 'ds',
        prNumber: 2,
        reviewer: 'r',
        decision: 'approved',
        createdAt: '2026-01-02',
      },
      {
        bindingName: 'ds',
        prNumber: 3,
        reviewer: 'r',
        decision: 'approved',
        createdAt: '2026-01-01',
      },
    ];
    // PR 1: first-pass approved ✓
    // PR 2: first was rejected ✗
    // PR 3: first-pass approved ✓
    expect(computeDesignReviewFirstPassRate(events)).toBeCloseTo(2 / 3);
  });
});

describe('computeUsabilitySimulationPassRate', () => {
  it('returns 1 for no results', () => {
    expect(computeUsabilitySimulationPassRate([])).toBe(1);
  });

  it('computes pass rate', () => {
    const results: UsabilitySimulationResultRecord[] = [
      { bindingName: 'ds', storyName: 'a', completed: true },
      { bindingName: 'ds', storyName: 'b', completed: true },
      { bindingName: 'ds', storyName: 'c', completed: false },
    ];
    expect(computeUsabilitySimulationPassRate(results)).toBeCloseTo(2 / 3);
  });
});

describe('computeTokenComplianceTrend', () => {
  it('returns stable for empty history', () => {
    expect(computeTokenComplianceTrend([]).trend).toBe('stable');
  });

  it('returns stable for single entry', () => {
    const result = computeTokenComplianceTrend([
      { bindingName: 'ds', coveragePercent: 85, violationsCount: 3, scannedAt: ts },
    ]);
    expect(result.current).toBe(85);
    expect(result.trend).toBe('stable');
  });

  it('detects improving trend', () => {
    const result = computeTokenComplianceTrend([
      { bindingName: 'ds', coveragePercent: 80, violationsCount: 5, scannedAt: '2026-01-01' },
      { bindingName: 'ds', coveragePercent: 88, violationsCount: 2, scannedAt: '2026-01-02' },
    ]);
    expect(result.trend).toBe('improving');
    expect(result.current).toBe(88);
  });

  it('detects declining trend', () => {
    const result = computeTokenComplianceTrend([
      { bindingName: 'ds', coveragePercent: 90, violationsCount: 1, scannedAt: '2026-01-01' },
      { bindingName: 'ds', coveragePercent: 82, violationsCount: 6, scannedAt: '2026-01-02' },
    ]);
    expect(result.trend).toBe('declining');
  });
});

describe('computeVisualRegressionPassRate', () => {
  it('returns 1 for no results', () => {
    expect(computeVisualRegressionPassRate([])).toBe(1);
  });

  it('computes pass rate against default threshold', () => {
    const results: VisualRegressionResultRecord[] = [
      { bindingName: 'ds', storyName: 'a', diffPercentage: 0.005 },
      { bindingName: 'ds', storyName: 'b', diffPercentage: 0.05 },
      { bindingName: 'ds', storyName: 'c', diffPercentage: 0 },
    ];
    expect(computeVisualRegressionPassRate(results)).toBeCloseTo(2 / 3);
  });
});

describe('computeDesignMetrics', () => {
  it('computes all six metrics', () => {
    const metrics = computeDesignMetrics({
      reviewEvents: [
        { bindingName: 'ds', prNumber: 1, reviewer: 'r', decision: 'approved', createdAt: ts },
      ],
      complianceHistory: [
        { bindingName: 'ds', coveragePercent: 91, violationsCount: 2, scannedAt: ts },
      ],
      visualRegressionResults: [{ bindingName: 'ds', storyName: 'a', diffPercentage: 0 }],
      usabilitySimulationResults: [{ bindingName: 'ds', storyName: 'a', completed: true }],
      designCiTotalCount: 10,
      designCiPassCount: 9,
      designCiAutoFixCount: 1,
      designCiFailCount: 1,
      findingsAccepted: 8,
      findingsDismissed: 2,
    });

    expect(metrics.designCiPassRate).toBe(0.9);
    expect(metrics.usabilitySimulationPassRate).toBe(1);
    expect(metrics.designReviewApprovalRate).toBe(1);
    expect(metrics.designReviewFirstPassRate).toBe(1);
    expect(metrics.designCiAutoFixRate).toBe(1);
    expect(metrics.usabilityFindingAccuracy).toBe(0.8);
  });

  it('returns defaults for empty data', () => {
    const metrics = computeDesignMetrics({
      reviewEvents: [],
      complianceHistory: [],
      visualRegressionResults: [],
      usabilitySimulationResults: [],
    });

    expect(metrics.designCiPassRate).toBe(1);
    expect(metrics.usabilitySimulationPassRate).toBe(1);
    expect(metrics.designReviewApprovalRate).toBe(1);
    expect(metrics.designReviewFirstPassRate).toBe(1);
    expect(metrics.designCiAutoFixRate).toBe(1);
    expect(metrics.usabilityFindingAccuracy).toBe(1);
  });
});
