/**
 * Fallback plan, built without a model, used when a planner's output is
 * rejected twice.
 *
 * The fallback plan is the UNMODIFIED baseline plus one `read` probe for every
 * high-risk or security-flagged hunk the baseline leaves uncovered. Because the
 * baseline is carried over untouched, the plan may be re-validated against the
 * same baseline without a modified-baseline-probe failure.
 *
 * Fail closed: the baseline is built from the change's own file paths, so a
 * change can name files that must not be probed. Every baseline probe gets the
 * same safety checks as a model-authored plan (paths, containment, queries, run
 * commands, revisions). If ANY probe carries ANY unsafe reference, there is no
 * plan at all: the result is `{ ok: false, rejections }` with no `plan` field,
 * so a caller cannot run a degraded plan. When `ok` is false the staged review
 * must not run on this change; the caller falls back to the existing reviewer
 * set, which remains the default. A baseline over the absolute ceilings is also
 * `ok: false`.
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
import type {
  Baseline,
  PlanLimits,
  Probe,
  Rejection,
  ReviewPlan,
  RiskHunk,
  RiskMapInput,
} from './types.js';

export type FallbackResult =
  | { ok: true; plan: ReviewPlan; rejections: [] }
  | { ok: false; rejections: Rejection[] };

function needsCoverage(h: RiskHunk, threshold: number): boolean {
  return isHighRisk(h, threshold) || h.flags.length > 0;
}

export function buildFallbackPlan(
  baseline: Baseline,
  riskMap: RiskMapInput,
  limits: PlanLimits,
): FallbackResult {
  const rejections: Rejection[] = [];
  for (const p of baseline.probes) rejections.push(...probeSafetyProblems(p, riskMap, limits));

  const covered = new Set(baseline.probes.flatMap((p) => p.covers));
  const reads: Probe[] = [];
  [...riskMap.hunks]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .forEach((h, i) => {
      if (!needsCoverage(h, limits.riskThreshold) || covered.has(h.id)) return;
      const read: Probe = {
        id: `fallback-read-${i}`,
        type: 'read',
        target: { files: [{ path: h.file, startLine: h.startLine, endLine: h.endLine }] },
        question: 'What does this hunk change, and what could go wrong?',
        covers: [h.id],
      };
      rejections.push(...probeSafetyProblems(read, riskMap, limits));
      reads.push(read);
    });

  const probes = [...baseline.probes, ...reads];
  const bytes = probes.reduce((n, p) => n + targetBytes(p.target), 0);
  if (probes.length > ABSOLUTE_MAX_PROBES || bytes > ABSOLUTE_MAX_TARGET_BYTES)
    rejections.push({
      reason: 'baseline-over-ceiling',
      detail: 'the fallback plan exceeds the absolute probe or size ceiling',
    });

  if (rejections.length > 0) {
    rejections.push({
      reason: 'unreviewable-input',
      detail: 'the change cannot be reviewed by the staged set; use the existing reviewer set',
    });
    return { ok: false, rejections };
  }
  return {
    ok: true,
    plan: { schemaVersion: 1, baselineVersion: baseline.version, probes },
    rejections: [],
  };
}
