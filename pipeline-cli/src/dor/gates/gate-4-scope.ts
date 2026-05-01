/**
 * Gate 4 — Scope is bounded.
 *
 * Per RFC §4.4 this gate is **fully Stage B** — the "fits in one PR"
 * judgement is semantic. Stage A returns `verdict: 'skip'` so the
 * orchestrator records that Stage B owns the verdict. Until Phase 2b
 * lands, the rubric admits Stage A passers as `ready` (RFC §12 Phase 2a
 * acceptance: "ships standalone").
 *
 * Stage A still emits a single soft heuristic finding when the body is
 * obviously huge — > 200 lines or AC count > 12 — which Stage B can
 * use as a starting hint. The heuristic does NOT fail the gate.
 */

import { extractAcceptanceCriteria } from './gate-1-ac-testable.js';
import type { GateEvaluation, IssueInput } from '../types.js';

const SOFT_BODY_LINE_LIMIT = 200;
const SOFT_AC_LIMIT = 12;

export function evaluateGate4(input: IssueInput): GateEvaluation {
  const ac = extractAcceptanceCriteria(input.body);
  const lineCount = input.body.split('\n').length;

  const isHugeBody = lineCount > SOFT_BODY_LINE_LIMIT;
  const isHugeAcCount = ac.count > SOFT_AC_LIMIT;

  const finding =
    isHugeBody || isHugeAcCount
      ? `Soft heuristic: body=${lineCount} lines, AC count=${ac.count} (Stage B will judge whether this fits one PR).`
      : undefined;

  return {
    gateId: 4,
    verdict: 'skip',
    severity: 'block',
    stage: 'A',
    confidence: 'low',
    finding,
  };
}
