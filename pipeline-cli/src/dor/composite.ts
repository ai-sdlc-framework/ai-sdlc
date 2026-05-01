/**
 * Composite Stage A + Stage B evaluator.
 *
 * RFC-0011 Phase 2b (AISDLC-115.3). `evaluateIssueE2E()` is the
 * end-to-end entry point: it runs Stage A, decides which gates need a
 * Stage B verdict, dispatches Stage B via the injected spawner, merges
 * per-gate verdicts, and produces a `RefinementVerdict` that maps 1:1
 * onto `spec/schemas/refinement-verdict.v1.schema.json`.
 *
 * Aggregation rules:
 *   - Per-gate winner: Stage B's verdict wins for every gate in
 *     `STAGE_B_OWNED_GATES` and for any gate Stage A passed with
 *     non-high confidence (Stage A's job there was preliminary). Stage A
 *     wins for definitive blocks (`fail` + `severity: 'block'` + high
 *     confidence) — the LLM doesn't get to override hard structural
 *     failures.
 *   - Overall verdict: any final gate `verdict: 'fail'` ⇒
 *     `needs-clarification`; otherwise `admit`.
 *   - Aggregate confidence per RFC §5.5 / Q4: floor across contributing
 *     gates. Any 'low' ⇒ 'low' (escalate). Else any 'medium' ⇒ 'medium'
 *     (act + spot-check). Else 'high'.
 */

import { evaluateIssue, type EvaluateOpts } from './evaluate.js';
import {
  evaluateStageB,
  pickStageBGates,
  STAGE_B_EVALUATOR_VERSION,
  type StageBOpts,
  type StageBResult,
} from './stage-b.js';
import type {
  GateConfidence,
  GateEvaluation,
  IssueInput,
  OverallVerdict,
  RefinementVerdict,
  StageAVerdict,
} from './types.js';

export interface EvaluateE2EOpts extends EvaluateOpts {
  /**
   * Stage B options. When omitted, Stage B is skipped entirely and the
   * Stage A verdict is returned (with its `durationMs` stripped) — same
   * as Phase 2a behaviour. Tests that don't need Stage B coverage can
   * omit this for speed.
   */
  stageB?: StageBOpts;
  /** Override the composite evaluator version stamp. */
  e2eEvaluatorVersion?: string;
}

const E2E_EVALUATOR_VERSION = `e2e-${STAGE_B_EVALUATOR_VERSION}`;

/**
 * Run Stage A + Stage B end-to-end. When `opts.stageB` is omitted,
 * returns the Stage A verdict cast to `RefinementVerdict` (no Stage B
 * call). When provided, dispatches Stage B for the chosen gate set and
 * merges per-gate verdicts.
 */
export async function evaluateIssueE2E(
  input: IssueInput,
  opts: EvaluateE2EOpts = {},
): Promise<RefinementVerdict> {
  const stageA = await evaluateIssue(input, opts);

  if (!opts.stageB) {
    // No spawner provided — return Stage A as-is, schema-shaped.
    return stripDurationMs(stageA);
  }

  const stageB = await evaluateStageB(input, stageA, opts.stageB);

  return mergeVerdicts(stageA, stageB, opts.e2eEvaluatorVersion ?? E2E_EVALUATOR_VERSION);
}

/**
 * Merge Stage A + Stage B per-gate verdicts and produce the composite.
 * Exported for the corpus runner (which needs to drive the merge with
 * per-fixture Stage B verdicts directly).
 */
export function mergeVerdicts(
  stageA: StageAVerdict,
  stageB: StageBResult,
  evaluatorVersion: string = E2E_EVALUATOR_VERSION,
): RefinementVerdict {
  const stageBGateIds = new Set(stageB.gateEvaluations.keys());

  const mergedGates: GateEvaluation[] = stageA.gates.map((aGate) => {
    if (!stageBGateIds.has(aGate.gateId)) {
      return aGate;
    }
    const bGate = stageB.gateEvaluations.get(aGate.gateId)!;
    return chooseWinner(aGate, bGate);
  });

  const blockingFails = mergedGates.filter((g) => g.verdict === 'fail' && g.severity === 'block');
  const overallVerdict: OverallVerdict = blockingFails.length > 0 ? 'needs-clarification' : 'admit';

  const questions = mergedGates
    .map((g) => g.clarificationQuestion)
    .filter((q): q is string => typeof q === 'string' && q.length > 0);

  const overallConfidence = aggregateConfidence(mergedGates);
  const summary = stageB.summary ?? buildE2ESummary(mergedGates, overallVerdict);

  return {
    issueId: stageA.issueId,
    rubricVersion: 'v1',
    overallVerdict,
    gates: mergedGates,
    signedAt: stageA.signedAt,
    evaluatorVersion,
    summary,
    questions,
    overallConfidence,
  };
}

/**
 * Per-gate winner rule. Stage A wins for definitive structural blocks
 * (high-confidence fail); Stage B wins everywhere else (including
 * 'skip' from either stage falling back to the other).
 */
export function chooseWinner(a: GateEvaluation, b: GateEvaluation): GateEvaluation {
  // Stage A high-confidence block: Stage A wins. The LLM cannot override
  // a structural failure (no AC checklist, fenced markers, broken refs).
  if (a.verdict === 'fail' && a.severity === 'block' && a.confidence === 'high') {
    return a;
  }
  // Stage B skipped (no verdict / parse failure): fall back to Stage A
  // when it actually produced one; otherwise keep the skip so the
  // confidence floor surfaces it.
  if (b.verdict === 'skip' && a.verdict !== 'skip') {
    return a;
  }
  // Default: Stage B wins for the gates we asked it about.
  return b;
}

/**
 * Aggregate confidence per RFC §5.5 / Q4 — floor across contributing
 * gates. Stage A 'skip' verdicts on owned-by-B gates don't contribute
 * (Stage B's verdict carries the weight there).
 */
export function aggregateConfidence(gates: GateEvaluation[]): GateConfidence {
  const blocking = gates.filter((g) => g.verdict === 'fail' && g.severity === 'block');
  if (blocking.length > 0) {
    if (blocking.some((g) => g.confidence === 'low')) return 'low';
    if (blocking.every((g) => g.confidence === 'high')) return 'high';
    return 'medium';
  }
  const contributing = gates.filter((g) => g.verdict !== 'skip');
  if (contributing.length === 0) return 'low';
  if (contributing.some((g) => g.confidence === 'low')) return 'low';
  if (contributing.every((g) => g.confidence === 'high')) return 'high';
  return 'medium';
}

function buildE2ESummary(gates: GateEvaluation[], overall: OverallVerdict): string {
  if (overall === 'admit') {
    return 'Stage A + Stage B admit — all gates passed.';
  }
  const failed = gates
    .filter((g) => g.verdict === 'fail')
    .map((g) => `Gate ${g.gateId}${g.stage === 'B' ? ' (B)' : ''}`);
  return `Stage A + Stage B blocked on ${failed.join(', ')}.`;
}

/**
 * Convert a `StageAVerdict` (which carries the internal `durationMs`)
 * into a schema-clean `RefinementVerdict`. The schema sets
 * `additionalProperties: false`, so we strip non-schema fields before
 * persisting.
 */
export function stripDurationMs(v: StageAVerdict): RefinementVerdict {
  const { durationMs: _drop, ...rest } = v;
  void _drop;
  return {
    ...rest,
    rubricVersion: 'v1',
  };
}

/** Re-export for callers — convenient single import surface. */
export { pickStageBGates };
