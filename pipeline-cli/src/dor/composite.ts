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

import { evaluateJudgment, type EvaluateJudgmentContext } from '@ai-sdlc/reference';
import { evaluateIssue, type EvaluateOpts } from './evaluate.js';
import {
  applyJudgedGates,
  buildDorJudgmentInput,
  ALL_GATES_PASS,
  dorStageBJudgment,
  dorStageBPassJudgment,
  judgedGatesOf,
  judgmentSourceKind,
  type DorJudgmentDecision,
} from './stage-b-judgment.js';
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
  /**
   * Judgment layer context for the Stage B readiness judgment. Omitted means the
   * judgment is not consulted. When the layer is disabled, in shadow, or abstains,
   * the result is identical to running without it.
   */
  judgment?: { context: EvaluateJudgmentContext };
}

/** Where the Stage B verdicts of an evaluation came from (recorded in the calibration log). */
export type StageBSource = 'none' | 'judgment' | 'subagent' | 'judgment+subagent';

export interface EvaluateE2EDetailed {
  verdict: RefinementVerdict;
  stageBSource: StageBSource;
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
  return (await evaluateIssueE2EDetailed(input, opts)).verdict;
}

/**
 * Same as `evaluateIssueE2E`, also reporting whether the Stage B verdicts came from
 * the judgment, the subagent or both.
 *
 * Judgment rules (the tighten half; the relax half is `allGatesPass`):
 *   - a supplied spawner always runs, exactly as without the judgment; a judged fail can
 *     only add a failed gate, never remove one;
 *   - with no spawner, a judged fail fails the gate (any source kind) and a judged pass
 *     only fills a gate that would otherwise be `skip` (backlog items only);
 *   - a gate Stage A failed stays failed at any confidence, and a Stage A pass stays a
 *     pass; the judged result never goes through `chooseWinner`.
 */
export async function evaluateIssueE2EDetailed(
  input: IssueInput,
  opts: EvaluateE2EOpts = {},
): Promise<EvaluateE2EDetailed> {
  const stageA = await evaluateIssue(input, opts);
  const version = opts.e2eEvaluatorVersion ?? E2E_EVALUATOR_VERSION;

  const judged = opts.judgment
    ? await runJudgment(input, stageA, opts.judgment.context)
    : undefined;

  // The relax half: skip the reviewer only on an `all-gates-pass` act from the pass
  // judgment. Runs only for trusted backlog work, only when Stage A failed nothing, and only
  // when the tighten judgment found no failing gate; in shadow or disabled it abstains.
  if (opts.judgment && (await allGatesPass(input, stageA, judged, opts.judgment.context))) {
    const everyGate = Object.fromEntries(
      pickStageBGates(stageA).map((id) => [`${id}`, 'pass' as const]),
    );
    const applied = applyJudgedGates(stageA.gates, everyGate, { fillPass: true });
    return {
      verdict: finalizeVerdict(
        stageA,
        applied.gates,
        opts.e2eEvaluatorVersion ?? `e2e-judgment-pass-v${dorStageBPassJudgment.version}`,
      ),
      stageBSource: 'judgment',
    };
  }

  if (!opts.stageB) {
    if (judged) {
      const applied = applyJudgedGates(stageA.gates, judged, {
        fillPass: input.source === 'backlog',
      });
      if (applied.changed.length > 0) {
        return {
          verdict: finalizeVerdict(
            stageA,
            applied.gates,
            opts.e2eEvaluatorVersion ?? `e2e-judgment-v${dorStageBJudgment.version}`,
          ),
          stageBSource: 'judgment',
        };
      }
    }
    // No spawner and nothing the judgment may change: Stage A as-is, schema-shaped.
    return { verdict: stripDurationMs(stageA), stageBSource: 'none' };
  }

  const stageB = await evaluateStageB(input, stageA, opts.stageB);
  const merged = mergeVerdicts(stageA, stageB, version);
  if (judged) {
    // Extension point: a separate, bidirectional "pass" judgment would plug in here.
    // It is intentionally not built; today the judgment can only add failures.
    const applied = applyJudgedGates(merged.gates, judged, { fillPass: false });
    if (applied.changed.length > 0) {
      return {
        verdict: finalizeVerdict(stageA, applied.gates, version),
        stageBSource: 'judgment+subagent',
      };
    }
  }
  return { verdict: merged, stageBSource: 'subagent' };
}

/**
 * True only when `dor.stage-b-pass` acted with `all-gates-pass` for trusted backlog work.
 * The checks here repeat the compose guards on purpose: the wiring must not rely on the
 * judgment alone to keep the relax path off untrusted sources or off a Stage A failure.
 */
async function allGatesPass(
  input: IssueInput,
  stageA: StageAVerdict,
  tightened: DorJudgmentDecision['gates'] | undefined,
  context: EvaluateJudgmentContext,
): Promise<boolean> {
  if (input.source !== 'backlog') return false;
  if (stageA.gates.some((g) => g.verdict === 'fail')) return false;
  if (tightened && Object.values(tightened).includes('fail')) return false;
  const judgmentInput = buildDorJudgmentInput(input, stageA);
  if (judgmentInput.gateIds.length === 0) return false;
  const outcome = await evaluateJudgment(dorStageBPassJudgment, judgmentInput, {
    ...context,
    sourceKind: judgmentSourceKind(input.source),
  });
  return outcome.kind === 'act' && outcome.decision.outcome === ALL_GATES_PASS;
}

/** Run the Stage B judgment; undefined when it abstains or has nothing to ask. */
async function runJudgment(
  input: IssueInput,
  stageA: StageAVerdict,
  context: EvaluateJudgmentContext,
): Promise<DorJudgmentDecision['gates'] | undefined> {
  const judgmentInput = buildDorJudgmentInput(input, stageA);
  if (judgmentInput.gateIds.length === 0) return undefined;
  const outcome = await evaluateJudgment(dorStageBJudgment, judgmentInput, {
    ...context,
    sourceKind: judgmentSourceKind(input.source),
    incumbent: {
      gates: Object.fromEntries(stageA.gates.map((g) => [`${g.gateId}`, g.verdict])),
    },
  });
  return judgedGatesOf(outcome);
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

  return finalizeVerdict(stageA, mergedGates, evaluatorVersion, stageB.summary);
}

/** Build the composite verdict from final per-gate evaluations. */
function finalizeVerdict(
  stageA: StageAVerdict,
  mergedGates: GateEvaluation[],
  evaluatorVersion: string,
  agentSummary?: string,
): RefinementVerdict {
  const blockingFails = mergedGates.filter((g) => g.verdict === 'fail' && g.severity === 'block');
  const overallVerdict: OverallVerdict = blockingFails.length > 0 ? 'needs-clarification' : 'admit';

  const questions = mergedGates
    .map((g) => g.clarificationQuestion)
    .filter((q): q is string => typeof q === 'string' && q.length > 0);

  const overallConfidence = aggregateConfidence(mergedGates);
  const summary = agentSummary ?? buildE2ESummary(mergedGates, overallVerdict);

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
