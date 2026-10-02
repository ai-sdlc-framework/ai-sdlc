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
  fileRefProblems,
  probeNonFileProblems,
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

/**
 * `ok` is what callers branch on. `ok: false` means coverage was lost: a
 * high-risk hunk has no safe probe, or the plan exceeds an absolute ceiling.
 * `plan` is still returned for inspection, but must not be run as a complete
 * review. `rejections` lists every drop, whether or not `ok` is true.
 */
export type FallbackResult =
  | { ok: true; plan: ReviewPlan; rejections: Rejection[] }
  | { ok: false; plan: ReviewPlan; rejections: Rejection[] };

/** Probes the fallback may never silently lose: security, scope, tests, and anything covering a hunk. */
function isCritical(p: Probe): boolean {
  return (
    p.id.startsWith('sec-') ||
    p.id === 'scope-search' ||
    p.id === 'tests-run' ||
    p.id === 'criteria-vs-tests' ||
    p.covers.length > 0
  );
}

function needsCoverage(h: RiskHunk, threshold: number): boolean {
  return isHighRisk(h, threshold) || h.flags.length > 0;
}

export function buildFallbackPlan(
  baseline: Baseline,
  riskMap: RiskMapInput,
  limits: PlanLimits,
): FallbackResult {
  const rejections: Rejection[] = [];
  const kept: Probe[] = [];

  // Strip only the unsafe file refs from a probe, recording each; keep the probe while
  // a safe target remains. A probe that is dropped or loses every target is reported,
  // and when it is critical the result is not ok.
  const sanitize = (p: Probe): Probe | null => {
    const nonFile = probeNonFileProblems(p, limits);
    if (nonFile.length > 0) {
      rejections.push(...nonFile);
      return null;
    }
    const files = p.target.files;
    if (!files) return p;
    const safe = files.filter((f) => {
      const problems = fileRefProblems(p, f, riskMap, limits);
      for (const r of problems) rejections.push({ ...r, detail: `${r.detail} (ref stripped)` });
      return problems.length === 0;
    });
    if (safe.length === files.length) return p;
    const target = { ...p.target };
    if (safe.length > 0) target.files = safe;
    else delete target.files;
    const hasTarget =
      safe.length > 0 ||
      (p.type !== 'run' && ((target.symbols?.length ?? 0) > 0 || target.query !== undefined));
    return hasTarget ? { ...p, target } : null;
  };

  for (const p of baseline.probes) {
    const out = sanitize(p);
    if (out) kept.push(out);
    else if (isCritical(p))
      rejections.push({
        reason: 'critical-baseline-probe-lost',
        probeId: p.id,
        detail: `baseline probe ${p.id} has no safe target left and cannot be run`,
      });
  }

  const covered = new Set(kept.flatMap((p) => p.covers));
  [...riskMap.hunks]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .forEach((h, i) => {
      if (!needsCoverage(h, limits.riskThreshold) || covered.has(h.id)) return;
      const probe: Probe = {
        id: `fallback-read-${i}`,
        type: 'read',
        target: { files: [{ path: h.file, startLine: h.startLine, endLine: h.endLine }] },
        question: 'What does this hunk change, and what could go wrong?',
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

  // A high-risk or security-flagged hunk whose probes were all dropped stays uncovered, and says so.
  const finalCovered = new Set(kept.flatMap((p) => p.covers));
  for (const h of riskMap.hunks)
    if (needsCoverage(h, limits.riskThreshold) && !finalCovered.has(h.id))
      rejections.push({
        reason: 'uncovered-high-risk-hunk',
        detail: `hunk ${h.id} is high-risk or security-flagged and has no safe probe in the fallback plan`,
      });

  const plan: ReviewPlan = { schemaVersion: 1, baselineVersion: baseline.version, probes: kept };
  const lostCoverage = rejections.some(
    (r) =>
      r.reason === 'uncovered-high-risk-hunk' ||
      r.reason === 'baseline-over-ceiling' ||
      r.reason === 'critical-baseline-probe-lost',
  );
  return lostCoverage ? { ok: false, plan, rejections } : { ok: true, plan, rejections };
}
