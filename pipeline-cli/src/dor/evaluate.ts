/**
 * Definition-of-Ready evaluator — Stage A entry point.
 *
 * RFC-0011 Phase 2a — `evaluateIssue()` runs the 7 deterministic gates
 * in series and aggregates a `StageAVerdict`. Stage B (LLM, Phase 2b)
 * lands in AISDLC-115.3; until then this module is the whole pipeline,
 * and an issue that passes Stage A is admitted as `ready` (RFC §12
 * Phase 2a acceptance: "ships standalone").
 *
 * Aggregation rules per RFC §4.3 + §4.4:
 *   - Any `verdict: 'fail'` with `severity: 'block'` ⇒ overall
 *     `needs-clarification`.
 *   - All other gates `pass` or `skip` ⇒ overall `admit`.
 *
 * Performance budget per RFC §12 Phase 2a is **<100ms per issue**. The
 * resolver registry's network-touching gates (gate 3 with real github /
 * URL refs) are excluded from the local budget — the CI gate test
 * stubs them out.
 */

import { evaluateGate1 } from './gates/gate-1-ac-testable.js';
import { evaluateGate2 } from './gates/gate-2-no-markers.js';
import { evaluateGate3, type Gate3Opts } from './gates/gate-3-references.js';
import { evaluateGate4 } from './gates/gate-4-scope.js';
import { evaluateGate5 } from './gates/gate-5-surface.js';
import { evaluateGate6 } from './gates/gate-6-done-state.js';
import { evaluateGate7 } from './gates/gate-7-deps.js';
import type { GateEvaluation, IssueInput, StageAVerdict } from './types.js';

export interface EvaluateOpts {
  /**
   * Skip gates that touch the network (currently just gate 3 when it
   * would call `gh` or `fetch`). Tests use this to keep evaluation
   * hermetic and within the local 100ms budget.
   */
  hermetic?: boolean;
  /** Pass-through to gate 3 (resolver overrides). */
  gate3?: Gate3Opts;
  /** Override the date used for `signedAt`. Used by tests for snapshotting. */
  now?: () => Date;
  /** Override evaluator version for snapshotting. */
  evaluatorVersion?: string;
}

const EVALUATOR_VERSION = 'stage-a-2026.05.01';

export async function evaluateIssue(
  input: IssueInput,
  opts: EvaluateOpts = {},
): Promise<StageAVerdict> {
  const startedAt = Date.now();

  const gates: GateEvaluation[] = [
    evaluateGate1(input),
    evaluateGate2(input),
    await evaluateGate3Hermetic(input, opts),
    evaluateGate4(input),
    evaluateGate5(input),
    evaluateGate6(input),
    evaluateGate7(input),
  ];

  // Aggregate
  const blockingFails = gates.filter((g) => g.verdict === 'fail' && g.severity === 'block');
  const overallVerdict: StageAVerdict['overallVerdict'] =
    blockingFails.length > 0 ? 'needs-clarification' : 'admit';

  const questions = gates
    .map((g) => g.clarificationQuestion)
    .filter((q): q is string => typeof q === 'string' && q.length > 0);

  const overallConfidence = aggregateConfidence(gates);
  const summary = buildSummary(gates, overallVerdict);

  const now = opts.now ?? (() => new Date());
  const evaluatorVersion = opts.evaluatorVersion ?? EVALUATOR_VERSION;

  return {
    issueId: input.id,
    rubricVersion: input.rubricVersion ?? 'v1',
    overallVerdict,
    gates,
    signedAt: now().toISOString(),
    evaluatorVersion,
    summary,
    questions,
    overallConfidence,
    durationMs: Date.now() - startedAt,
  };
}

async function evaluateGate3Hermetic(
  input: IssueInput,
  opts: EvaluateOpts,
): Promise<GateEvaluation> {
  if (opts.hermetic) {
    // Treat gate 3 as a vacuous pass — Stage A's network-touching half
    // is excluded; the local-only resolvers (file-existence) still run.
    const gate3opts: Gate3Opts = {
      ...opts.gate3,
      // Keep file-existence resolver, but kill remote calls.
      resolvers: opts.gate3?.resolvers,
    };
    if (!gate3opts.resolvers) {
      const { fileExistenceResolver } = await import('./resolvers/file-existence.js');
      gate3opts.resolvers = [fileExistenceResolver];
    }
    return evaluateGate3(input, gate3opts);
  }
  return evaluateGate3(input, opts.gate3 ?? {});
}

function aggregateConfidence(gates: GateEvaluation[]): StageAVerdict['overallConfidence'] {
  const blocking = gates.filter((g) => g.verdict === 'fail' && g.severity === 'block');
  if (blocking.length > 0) {
    return blocking.every((g) => g.confidence === 'high') ? 'high' : 'medium';
  }
  // No blocking failures — confidence is the floor of all non-skip gate
  // confidences (Stage A skips for gates 4 and 6 are 'low' by design,
  // so we only consider gates that actually contributed a verdict).
  const contributing = gates.filter((g) => g.verdict !== 'skip');
  if (contributing.length === 0) return 'low';
  if (contributing.every((g) => g.confidence === 'high')) return 'high';
  if (contributing.some((g) => g.confidence === 'low')) return 'low';
  return 'medium';
}

function buildSummary(gates: GateEvaluation[], overall: StageAVerdict['overallVerdict']): string {
  const failed = gates.filter((g) => g.verdict === 'fail').map((g) => `Gate ${g.gateId}`);
  if (overall === 'admit') {
    return 'Stage A admit — all deterministic gates passed.';
  }
  return `Stage A blocked on ${failed.join(', ')}.`;
}

export const STAGE_A_PERF_BUDGET_MS = 100;
export { EVALUATOR_VERSION };
