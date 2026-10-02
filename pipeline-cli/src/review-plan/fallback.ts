/**
 * Fallback plan: the baseline plus a `read` probe for every high-risk hunk the
 * baseline leaves uncovered. Built without a model, used when a planner's output
 * is rejected twice.
 *
 * @module review-plan/fallback
 */

import { isHighRisk } from './baseline.js';
import type { Baseline, Probe, ReviewPlan, RiskMapInput } from './types.js';

export function buildFallbackPlan(
  baseline: Baseline,
  riskMap: RiskMapInput,
  riskThreshold: number,
): ReviewPlan {
  const covered = new Set(baseline.probes.flatMap((p) => p.covers));
  const extra: Probe[] = [];
  [...riskMap.hunks]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .forEach((h, i) => {
      if (!isHighRisk(h, riskThreshold) || covered.has(h.id)) return;
      extra.push({
        id: `fallback-read-${i}`,
        type: 'read',
        target: { files: [{ path: h.file, startLine: h.startLine, endLine: h.endLine }] },
        question: 'What does this high-risk hunk change, and what could go wrong?',
        covers: [h.id],
      });
    });
  return {
    schemaVersion: 1,
    baselineVersion: baseline.version,
    probes: [...baseline.probes, ...extra],
  };
}
