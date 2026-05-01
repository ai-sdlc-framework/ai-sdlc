/**
 * Gate 6 — Done-state is describable.
 *
 * Per RFC §4.4 this gate is **fully Stage B** — the "user-visible end
 * state" judgement is semantic. Stage A returns `verdict: 'skip'` so
 * the orchestrator records that Stage B owns the verdict. Until Phase
 * 2b lands, the rubric admits Stage A passers as `ready` (RFC §12 Phase
 * 2a acceptance: "ships standalone").
 *
 * Stage A still emits a soft signal when a Description section is
 * literally absent — that's not a definitive done-state failure (the
 * acceptance criteria themselves often describe done-state) but it's
 * a useful starting hint for Stage B.
 */

import type { GateEvaluation, IssueInput } from '../types.js';

const DESCRIPTION_HEADING_RE = /^##\s+Description\b/im;

export function evaluateGate6(input: IssueInput): GateEvaluation {
  const hasDescription = DESCRIPTION_HEADING_RE.test(input.body);
  const finding = hasDescription
    ? undefined
    : 'Soft heuristic: no "## Description" section (Stage B will judge whether done-state is describable from the AC list alone).';

  return {
    gateId: 6,
    verdict: 'skip',
    severity: 'block',
    stage: 'A',
    confidence: 'low',
    finding,
  };
}
