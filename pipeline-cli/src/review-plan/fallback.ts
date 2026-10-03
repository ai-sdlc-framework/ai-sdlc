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

import { validateReviewPlan } from '@ai-sdlc/reference';
import { BaselineInputError, buildBaselineProbes, isHighRisk } from './baseline.js';
import type { BuildBaselineOpts } from './baseline.js';
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
  TaskInput,
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

  const plan: ReviewPlan = { schemaVersion: 1, baselineVersion: baseline.version, probes };
  // `ok: true` means the plan is runnable, so it must also satisfy the schema: a baseline built
  // from a very large change, or a hunk with startLine 0, can break a per-probe limit that no
  // code check above covers.
  if (rejections.length === 0) {
    const schema = validateReviewPlan(plan);
    if (!schema.valid)
      rejections.push({
        reason: 'schema-invalid',
        detail:
          (schema.errors ?? [])
            .slice(0, 5)
            .map((e) => `${e.path || '/'} ${e.message}`)
            .join('; ') || 'the fallback plan does not satisfy the plan schema',
      });
  }

  if (rejections.length > 0) {
    rejections.push({
      reason: 'unreviewable-input',
      detail: 'the change cannot be reviewed by the staged set; use the existing reviewer set',
    });
    return { ok: false, rejections };
  }
  return { ok: true, plan, rejections: [] };
}

/**
 * Builds the baseline and then the fallback plan, never throwing. A risk map the checklist cannot
 * carry (an unsafe hunk id, an unknown security category) yields `{ ok: false }` with an
 * `unreviewable-input` rejection, the same fail-closed result as an unsafe reference, so a caller
 * that handles only {@link FallbackResult} cannot crash and cannot run a degraded plan.
 */
export function buildFallbackPlanFor(
  riskMap: RiskMapInput,
  task: TaskInput,
  baselineOpts: BuildBaselineOpts,
  limits: PlanLimits,
): FallbackResult {
  let baseline: Baseline;
  try {
    baseline = buildBaselineProbes(riskMap, task, baselineOpts);
  } catch (err) {
    if (!(err instanceof BaselineInputError)) throw err;
    return {
      ok: false,
      rejections: [
        {
          reason: 'unreviewable-input',
          detail: `the change cannot be reviewed by the staged set; use the existing reviewer set (${err.message})`,
        },
      ],
    };
  }
  return buildFallbackPlan(baseline, riskMap, limits);
}
