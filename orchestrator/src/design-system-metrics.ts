/**
 * Design system metrics for autonomy promotion/demotion (RFC-0006 §13.2, §A.10).
 *
 * Computes six design review metrics from state store data and integrates
 * them into the autonomy evaluation system.
 */

import type {
  DesignReviewEventRecord,
  TokenComplianceRecord,
  VisualRegressionResultRecord,
  UsabilitySimulationResultRecord,
} from './state/types.js';

// ── Metric Definitions ───────────────────────────────────────────────

export interface DesignMetrics {
  /** Percentage of Design CI runs that pass on first attempt. */
  designCiPassRate: number;
  /** Percentage of usability simulations that complete successfully. */
  usabilitySimulationPassRate: number;
  /** Percentage of design reviews approved (any decision except rejected). */
  designReviewApprovalRate: number;
  /** Percentage of design reviews approved without any rejection cycle. */
  designReviewFirstPassRate: number;
  /** Percentage of Design CI failures auto-fixed by correction loop. */
  designCiAutoFixRate: number;
  /** Precision of usability findings (accepted / (accepted + dismissed)). */
  usabilityFindingAccuracy: number;
}

// ── Metric Computation ───────────────────────────────────────────────

/**
 * Compute design review approval rate from review events.
 */
export function computeDesignReviewApprovalRate(events: DesignReviewEventRecord[]): number {
  if (events.length === 0) return 1;
  const approved = events.filter(
    (e) => e.decision === 'approved' || e.decision === 'approved-with-comments',
  ).length;
  return approved / events.length;
}

/**
 * Compute design review first-pass rate (approved without rejection cycles).
 * Groups events by PR and checks if the first review for each PR was an approval.
 */
export function computeDesignReviewFirstPassRate(events: DesignReviewEventRecord[]): number {
  if (events.length === 0) return 1;

  const prGroups = new Map<number, DesignReviewEventRecord[]>();
  for (const e of events) {
    if (e.prNumber === undefined) continue;
    const group = prGroups.get(e.prNumber) ?? [];
    group.push(e);
    prGroups.set(e.prNumber, group);
  }

  if (prGroups.size === 0) return 1;

  let firstPassCount = 0;
  for (const [, group] of prGroups) {
    // Sort by created_at, check if first is approved
    const sorted = group.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    if (sorted[0].decision === 'approved' || sorted[0].decision === 'approved-with-comments') {
      firstPassCount++;
    }
  }

  return firstPassCount / prGroups.size;
}

/**
 * Compute usability simulation pass rate from simulation results.
 */
export function computeUsabilitySimulationPassRate(
  results: UsabilitySimulationResultRecord[],
): number {
  if (results.length === 0) return 1;
  const passed = results.filter((r) => r.completed).length;
  return passed / results.length;
}

/**
 * Compute token compliance trend from compliance history.
 */
export function computeTokenComplianceTrend(history: TokenComplianceRecord[]): {
  current: number;
  trend: 'improving' | 'stable' | 'declining';
} {
  if (history.length === 0) return { current: 0, trend: 'stable' };
  if (history.length === 1) return { current: history[0].coveragePercent, trend: 'stable' };

  const sorted = [...history].sort((a, b) => (a.scannedAt ?? '').localeCompare(b.scannedAt ?? ''));
  const current = sorted[sorted.length - 1].coveragePercent;
  const previous = sorted[sorted.length - 2].coveragePercent;

  const delta = current - previous;
  let trend: 'improving' | 'stable' | 'declining';
  if (delta > 1) trend = 'improving';
  else if (delta < -1) trend = 'declining';
  else trend = 'stable';

  return { current, trend };
}

/**
 * Compute visual regression pass rate from results.
 */
export function computeVisualRegressionPassRate(results: VisualRegressionResultRecord[]): number {
  if (results.length === 0) return 1;
  const threshold = 0.01; // default diff threshold
  const passed = results.filter((r) => r.diffPercentage <= threshold).length;
  return passed / results.length;
}

/**
 * Compute all six design metrics from state store data.
 */
export function computeDesignMetrics(data: {
  reviewEvents: DesignReviewEventRecord[];
  complianceHistory: TokenComplianceRecord[];
  visualRegressionResults: VisualRegressionResultRecord[];
  usabilitySimulationResults: UsabilitySimulationResultRecord[];
  designCiPassCount?: number;
  designCiTotalCount?: number;
  designCiAutoFixCount?: number;
  designCiFailCount?: number;
  findingsAccepted?: number;
  findingsDismissed?: number;
}): DesignMetrics {
  const ciTotal = data.designCiTotalCount ?? 0;
  const ciPass = data.designCiPassCount ?? ciTotal;
  const ciAutoFix = data.designCiAutoFixCount ?? 0;
  const ciFail = data.designCiFailCount ?? 0;

  const findingsAccepted = data.findingsAccepted ?? 0;
  const findingsDismissed = data.findingsDismissed ?? 0;
  const findingsTotal = findingsAccepted + findingsDismissed;

  return {
    designCiPassRate: ciTotal > 0 ? ciPass / ciTotal : 1,
    usabilitySimulationPassRate: computeUsabilitySimulationPassRate(
      data.usabilitySimulationResults,
    ),
    designReviewApprovalRate: computeDesignReviewApprovalRate(data.reviewEvents),
    designReviewFirstPassRate: computeDesignReviewFirstPassRate(data.reviewEvents),
    designCiAutoFixRate: ciFail > 0 ? ciAutoFix / ciFail : 1,
    usabilityFindingAccuracy: findingsTotal > 0 ? findingsAccepted / findingsTotal : 1,
  };
}
