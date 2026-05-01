/**
 * End-to-end (Stage A + Stage B) corpus runner.
 *
 * RFC-0011 §5.6 + §12 Phase 2b. Drives the full pipeline against the
 * `spec/dor-corpus/` fixtures and reports:
 *
 *   1. **Stage B match rate** — for the gate Stage B was asked about,
 *      did its verdict match the fixture's expected Stage B answer?
 *      Acceptance bar per RFC §5.6: ≥ 90%.
 *   2. **End-to-end verdict match rate** — does the composite verdict
 *      match the fixture's `e2e.overallVerdict`? Acceptance bar: ≥ 95%.
 *
 * The Stage A regression suite (`corpus.test.ts` →
 * `runStageACorpus()`) is unchanged and STILL the first-tier gate
 * (Stage A 100% per RFC §5.6 tier 1). This runner is the second + third
 * tier (Stage B ≥90%, E2E ≥95%) — additive.
 *
 * Per RFC §5.6 the runner uses a **calibrated MockSpawner** during
 * tests — the harness validates that orchestration + merge logic is
 * correct given a hypothetical "calibrated LLM". Real-LLM calibration
 * happens in Phase 7 soak (RFC §12).
 *
 * Fixture e2e shape (additive, opt-in):
 *
 * ```json
 * {
 *   "overallVerdict": "admit",        // existing — Stage A
 *   "e2e": {
 *     "overallVerdict": "needs-clarification",
 *     "failsGates": [4],
 *     "stageB": { "4": "fail" }       // optional — Stage B per-gate ground truth
 *   }
 * }
 * ```
 *
 * Fixtures without an `e2e` block default to:
 *   - `e2e.overallVerdict = expected.overallVerdict`
 *   - `e2e.failsGates = expected.failsGates ?? []`
 *   - `e2e.stageB = {}` (no Stage B ground truth → unscored at Stage B)
 *
 * That default keeps every existing fixture honest at E2E without
 * requiring backfill — a fixture that Stage A admits is also expected
 * to be admitted end-to-end UNLESS its `e2e` block says otherwise.
 */

import { evaluateIssue } from './evaluate.js';
import { evaluateStageB, pickStageBGates, STAGE_B_OWNED_GATES } from './stage-b.js';
import type { StageBOpts } from './stage-b.js';
import { loadCorpus, type CorpusFixture, type FixtureExpectation } from './corpus.js';
import { mergeVerdicts } from './composite.js';
import type { GateId, IssueInput, OverallVerdict, RefinementVerdict } from './types.js';

export interface FixtureE2EBlock {
  overallVerdict: OverallVerdict;
  failsGates?: GateId[];
  /**
   * Allow E2E to fail additional gates beyond `failsGates`. Mirrors the
   * Stage A `allowExtraFailures` flag — used for multi-gate fixtures
   * where Stage B may legitimately add Stage-B-owned failures on top.
   */
  allowExtraFailures?: boolean;
  /**
   * Optional per-gate ground truth for Stage B verdicts. Keys are
   * gate IDs as strings; values are the expected `verdict` ('pass' |
   * 'fail').
   */
  stageB?: Partial<Record<`${GateId}`, 'pass' | 'fail'>>;
}

export interface FixtureExpectationWithE2E extends FixtureExpectation {
  e2e?: FixtureE2EBlock;
}

export interface E2EFixtureResult {
  fixture: string;
  /** End-to-end overall verdict from the composite evaluator. */
  actualOverall: OverallVerdict;
  /** Whether the overall verdict matched the fixture's expectation. */
  e2eMatch: boolean;
  /** Stage B verdicts that contributed (per gate). */
  stageBVerdicts: Array<{ gateId: GateId; verdict: 'pass' | 'fail' | 'skip' }>;
  /** Stage B match results (only for fixtures with a `stageB` ground truth). */
  stageBChecks: Array<{
    gateId: GateId;
    expected: 'pass' | 'fail';
    actual: string;
    match: boolean;
  }>;
  /** Optional reason describing the mismatch for debugging output. */
  reason?: string;
}

export interface E2ECorpusReport {
  total: number;
  /** Number of fixtures whose E2E overall verdict matched. */
  e2eMatched: number;
  /** Match rate (0-1). */
  e2eMatchRate: number;
  /** Number of Stage B per-gate checks attempted across all fixtures. */
  stageBChecks: number;
  /** Number of those checks that matched. */
  stageBMatched: number;
  /** Stage B match rate (0-1). */
  stageBMatchRate: number;
  /** Per-fixture details. */
  results: E2EFixtureResult[];
}

export interface RunE2ECorpusOpts {
  /** Per-fixture override returning Stage B opts (typically a calibrated MockSpawner). */
  stageBOptsFor?: (fixture: CorpusFixture) => StageBOpts;
  /** Per-fixture input override (e.g. `workDir` so file resolvers find stubs). */
  inputOverride?: (fixture: CorpusFixture) => Partial<IssueInput>;
  /**
   * If true, fixtures without a `stageB` ground-truth block still get
   * Stage B run against them (used to exercise the orchestration path
   * end-to-end). Defaults to true.
   */
  alwaysRunStageB?: boolean;
}

/**
 * Execute the full Stage A + Stage B pipeline against every fixture and
 * compare against the `e2e` expected block. Returns a structured
 * report.
 */
export async function runE2ECorpus(
  corpusRoot: string,
  opts: RunE2ECorpusOpts,
): Promise<E2ECorpusReport> {
  const fixtures = loadCorpus(corpusRoot) as Array<
    CorpusFixture & { expected: FixtureExpectationWithE2E }
  >;
  const results: E2EFixtureResult[] = [];
  let e2eMatched = 0;
  let stageBChecks = 0;
  let stageBMatched = 0;

  for (const fx of fixtures) {
    const e2eExpect = effectiveE2E(fx.expected);
    const input: IssueInput = {
      source: 'backlog',
      id: fx.name,
      title: fx.name.replace(/-/g, ' '),
      body: fx.body,
      ...(opts.inputOverride ? opts.inputOverride(fx) : {}),
    };

    const stageA = await evaluateIssue(input, { hermetic: true });

    let composite: RefinementVerdict;
    let stageBVerdicts: E2EFixtureResult['stageBVerdicts'] = [];
    const stageBChecksHere: E2EFixtureResult['stageBChecks'] = [];

    const wantStageB = (opts.alwaysRunStageB ?? true) || pickStageBGates(stageA).length > 0;

    if (wantStageB && opts.stageBOptsFor) {
      const stageBOpts = opts.stageBOptsFor(fx);
      const stageB = await evaluateStageB(input, stageA, stageBOpts);
      composite = mergeVerdicts(stageA, stageB);
      stageBVerdicts = [...stageB.gateEvaluations.values()].map((g) => ({
        gateId: g.gateId,
        verdict: g.verdict,
      }));

      // Score Stage B verdicts against the ground truth (when fixture provides one).
      const truth = e2eExpect.stageB ?? {};
      for (const [gateIdStr, expected] of Object.entries(truth)) {
        const gateId = Number(gateIdStr) as GateId;
        const got = stageB.gateEvaluations.get(gateId);
        const actual = got?.verdict ?? 'skip';
        const match = actual === expected;
        stageBChecksHere.push({ gateId, expected, actual, match });
        stageBChecks++;
        if (match) stageBMatched++;
      }
    } else {
      // No Stage B — composite is Stage A schema-shaped.
      composite = mergeVerdicts(stageA, {
        gateEvaluations: new Map(),
        raw: { type: 'refinement-reviewer', output: '', status: 'success', durationMs: 0 },
      });
    }

    const actualOverall = composite.overallVerdict;
    const actualFails = composite.gates
      .filter((g) => g.verdict === 'fail')
      .map((g) => g.gateId)
      .sort((a, b) => a - b);

    const expectedFails = (e2eExpect.failsGates ?? []).slice().sort((a, b) => a - b);
    const allowExtra = e2eExpect.allowExtraFailures ?? false;
    const failsMatch = allowExtra
      ? expectedFails.every((id) => actualFails.includes(id))
      : arraysEqual(actualFails, expectedFails);
    const overallMatch = actualOverall === e2eExpect.overallVerdict;
    const e2eMatch = overallMatch && failsMatch;

    if (e2eMatch) e2eMatched++;

    results.push({
      fixture: fx.bodyPath,
      actualOverall,
      e2eMatch,
      stageBVerdicts,
      stageBChecks: stageBChecksHere,
      reason: e2eMatch
        ? undefined
        : `expected overall='${e2eExpect.overallVerdict}' fails=[${expectedFails.join(',')}], got '${actualOverall}' fails=[${actualFails.join(',')}]`,
    });
  }

  return {
    total: fixtures.length,
    e2eMatched,
    e2eMatchRate: fixtures.length === 0 ? 0 : e2eMatched / fixtures.length,
    stageBChecks,
    stageBMatched,
    stageBMatchRate: stageBChecks === 0 ? 0 : stageBMatched / stageBChecks,
    results,
  };
}

/**
 * Resolve the effective E2E expectation. Fixtures without an `e2e`
 * block inherit Stage A's expectation — that keeps existing fixtures
 * honest at E2E without backfill. `allowExtraFailures` is also inherited
 * so multi-gate Stage A fixtures stay tolerant of Stage-B-added failures.
 */
export function effectiveE2E(expected: FixtureExpectationWithE2E): FixtureE2EBlock {
  if (expected.e2e) return expected.e2e;
  return {
    overallVerdict: expected.overallVerdict,
    failsGates: expected.failsGates ?? [],
    allowExtraFailures: expected.allowExtraFailures ?? false,
    stageB: {},
  };
}

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Re-export for convenience. */
export { STAGE_B_OWNED_GATES };
