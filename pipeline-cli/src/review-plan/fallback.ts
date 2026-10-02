/**
 * Fallback plan: the baseline plus a `read` probe for every high-risk hunk the
 * baseline leaves uncovered. Built without a model, used when a planner's output
 * is rejected twice.
 *
 * The fallback is held to the same safety checks as a model-authored plan,
 * because a change can steer the planner into the fallback and the baseline is
 * built from the change's own file paths. Probes with unsafe or escaping file
 * references, a non-allowlisted run target, or non-test run files are dropped,
 * and each drop is returned as a rejection so nothing is silent. A baseline
 * over the absolute ceilings is reported the same way.
 *
 * @module review-plan/fallback
 */

import { isHighRisk } from './baseline.js';
import {
  ABSOLUTE_MAX_PROBES,
  ABSOLUTE_MAX_TARGET_BYTES,
  probeSafetyProblems,
  targetBytes,
} from './validate.js';
import type { Baseline, PlanLimits, Probe, Rejection, ReviewPlan, RiskMapInput } from './types.js';

/**
 * `ok` is what callers branch on. `ok: false` means coverage was lost: a
 * high-risk hunk has no safe probe, or the plan exceeds an absolute ceiling.
 * `plan` is still returned for inspection, but must not be run as a complete
 * review. `rejections` lists every drop, whether or not `ok` is true.
 */
export type FallbackResult =
  | { ok: true; plan: ReviewPlan; rejections: Rejection[] }
  | { ok: false; plan: ReviewPlan; rejections: Rejection[] };

export function buildFallbackPlan(
  baseline: Baseline,
  riskMap: RiskMapInput,
  limits: PlanLimits,
): FallbackResult {
  const rejections: Rejection[] = [];
  const kept: Probe[] = [];
  for (const p of baseline.probes) {
    const problems = probeSafetyProblems(p, riskMap, limits);
    if (problems.length > 0) rejections.push(...problems);
    else kept.push(p);
  }

  const covered = new Set(kept.flatMap((p) => p.covers));
  [...riskMap.hunks]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .forEach((h, i) => {
      if (!isHighRisk(h, limits.riskThreshold) || covered.has(h.id)) return;
      const probe: Probe = {
        id: `fallback-read-${i}`,
        type: 'read',
        target: { files: [{ path: h.file, startLine: h.startLine, endLine: h.endLine }] },
        question: 'What does this high-risk hunk change, and what could go wrong?',
        covers: [h.id],
      };
      const problems = probeSafetyProblems(probe, riskMap, limits);
      if (problems.length > 0) rejections.push(...problems);
      else kept.push(probe);
    });

  const bytes = kept.reduce((n, p) => n + targetBytes(p.target), 0);
  if (kept.length > ABSOLUTE_MAX_PROBES || bytes > ABSOLUTE_MAX_TARGET_BYTES)
    rejections.push({
      reason: 'baseline-over-ceiling',
      detail: 'the fallback plan exceeds the absolute probe or size ceiling',
    });

  // A high-risk hunk whose only probes were dropped stays uncovered, and says so.
  const finalCovered = new Set(kept.flatMap((p) => p.covers));
  for (const h of riskMap.hunks)
    if (isHighRisk(h, limits.riskThreshold) && !finalCovered.has(h.id))
      rejections.push({
        reason: 'uncovered-high-risk-hunk',
        detail: `high-risk hunk ${h.id} has no safe probe in the fallback plan`,
      });

  const plan: ReviewPlan = { schemaVersion: 1, baselineVersion: baseline.version, probes: kept };
  const lostCoverage = rejections.some(
    (r) => r.reason === 'uncovered-high-risk-hunk' || r.reason === 'baseline-over-ceiling',
  );
  return lostCoverage ? { ok: false, plan, rejections } : { ok: true, plan, rejections };
}
