/**
 * Shadow-mode evaluation harness.
 *
 * RFC-0011 §5.6: before promoting a candidate rubric (e.g. Stage A
 * baseline → Stage A + Stage B) we want disagreement-rate < 5% against
 * a reference workload. The "reference workload" in production is "the
 * last 4 weeks of real issues"; in tests it's the corpus.
 *
 * `runShadowEval()` runs both the baseline and candidate evaluators
 * against the same input set and reports per-issue agreement, total
 * agreement rate, and disagreement details. The acceptance criterion
 * (per RFC §5.6 + §12 Phase 2b AC #7) is `disagreementRate < 0.05`
 * BEFORE promoting the candidate.
 *
 * **Honest framing for tests** (see `shadow-mode.test.ts` header): we
 * don't have "the last 4 weeks of real issues" wired in — that belongs
 * to operator runbook (Phase 7 soak per RFC §12). The corpus IS the
 * test-time proxy. The function below is workload-agnostic — once an
 * operator points it at a real-issue stream, the same harness applies.
 */

import type { OverallVerdict, RefinementVerdict } from './types.js';

/**
 * Single-issue evaluator function the shadow harness drives. Both
 * baseline and candidate must accept the same input shape; signatures
 * are kept narrow on purpose so the harness composes with anything that
 * produces a `RefinementVerdict`.
 */
export type EvaluatorFn<In> = (input: In) => Promise<RefinementVerdict>;

export interface ShadowDisagreement {
  issueId: string;
  baseline: OverallVerdict;
  candidate: OverallVerdict;
}

export interface ShadowReport {
  total: number;
  agreed: number;
  disagreed: number;
  agreementRate: number;
  disagreementRate: number;
  disagreements: ShadowDisagreement[];
}

export interface ShadowOpts {
  /**
   * Optional progress callback fired per issue so long-running shadow
   * evals can stream status (Slack digest, dashboard).
   */
  onIssue?: (idx: number, total: number) => void;
}

/**
 * Run baseline and candidate evaluators against the same set of inputs
 * and report agreement.
 *
 * The function is intentionally agnostic of input shape — pass anything
 * the two evaluators both accept (typically `IssueInput` for live runs
 * or `CorpusFixture`-derived input for tests).
 */
export async function runShadowEval<In>(
  inputs: In[],
  baseline: EvaluatorFn<In>,
  candidate: EvaluatorFn<In>,
  opts: ShadowOpts = {},
): Promise<ShadowReport> {
  const disagreements: ShadowDisagreement[] = [];
  let agreed = 0;

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    opts.onIssue?.(i, inputs.length);

    const [b, c] = await Promise.all([baseline(input), candidate(input)]);

    if (b.overallVerdict === c.overallVerdict) {
      agreed++;
    } else {
      disagreements.push({
        issueId: b.issueId || c.issueId,
        baseline: b.overallVerdict,
        candidate: c.overallVerdict,
      });
    }
  }

  const total = inputs.length;
  return {
    total,
    agreed,
    disagreed: disagreements.length,
    agreementRate: total === 0 ? 1 : agreed / total,
    disagreementRate: total === 0 ? 0 : disagreements.length / total,
    disagreements,
  };
}

/**
 * RFC §5.6 / Phase 2b AC #7 promotion gate: disagreement rate must be
 * strictly less than this before flipping the candidate to active.
 */
export const SHADOW_DISAGREEMENT_THRESHOLD = 0.05;

/**
 * Convenience predicate matching the RFC §5.6 promotion gate. Use this
 * in CI / runbook scripts so the threshold lives in one place.
 */
export function shouldPromoteCandidate(report: ShadowReport): boolean {
  return report.disagreementRate < SHADOW_DISAGREEMENT_THRESHOLD;
}
