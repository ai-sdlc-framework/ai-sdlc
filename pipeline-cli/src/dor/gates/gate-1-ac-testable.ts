/**
 * Gate 1 — Acceptance criteria are binary-testable.
 *
 * Stage A (deterministic): structural check only.
 *   - AC count MUST be ≥ 1 and ≤ 20 (RFC §4.4 table)
 *   - Every AC entry MUST be non-empty after trimming
 *
 * The "is each AC actually binary-testable" judgement is Stage B (LLM)
 * and lands in Phase 2b. Stage A's job is to catch the obvious
 * structural failure — missing checklist, runaway scope, blank entries
 * — at zero LLM cost.
 *
 * RFC-0011 §4.4 — gate 1 row.
 */

import type { GateEvaluation, IssueInput } from '../types.js';

const AC_LINE_RE = /^- \[( |x|X)\] (?:#(\d+) )?(.*)$/gm;
/**
 * Heading patterns that introduce the acceptance-criteria section. Both
 * "## Acceptance Criteria" and the AC-specific HTML markers
 * (`<!-- AC:BEGIN -->`) are used in real backlog tasks; the rubric
 * accepts either.
 */
const AC_HEADING_RE = /^##\s+Acceptance Criteria\s*$/im;
const AC_BLOCK_MARKER = /<!--\s*AC:BEGIN\s*-->/i;

const MIN_ACS = 1;
const MAX_ACS = 20;

export function extractAcceptanceCriteria(body: string): {
  count: number;
  entries: string[];
  hasHeading: boolean;
  blankEntries: number;
} {
  const entries: string[] = [];
  let blank = 0;
  let m: RegExpExecArray | null;
  AC_LINE_RE.lastIndex = 0;
  while ((m = AC_LINE_RE.exec(body)) !== null) {
    const text = m[3].trim();
    entries.push(text);
    if (text.length === 0) blank++;
  }
  return {
    count: entries.length,
    entries,
    hasHeading: AC_HEADING_RE.test(body) || AC_BLOCK_MARKER.test(body),
    blankEntries: blank,
  };
}

export function evaluateGate1(input: IssueInput): GateEvaluation {
  const ac = extractAcceptanceCriteria(input.body);

  if (ac.count < MIN_ACS) {
    return {
      gateId: 1,
      verdict: 'fail',
      severity: 'block',
      stage: 'A',
      confidence: 'high',
      finding: ac.hasHeading
        ? 'Acceptance Criteria section is present but empty.'
        : 'Issue has no Acceptance Criteria section / checklist.',
      clarificationQuestion:
        'Add 1-20 acceptance criteria as a "## Acceptance Criteria" checklist (`- [ ] #1 ...`).',
    };
  }

  if (ac.count > MAX_ACS) {
    return {
      gateId: 1,
      verdict: 'fail',
      severity: 'block',
      stage: 'A',
      confidence: 'high',
      finding: `Acceptance Criteria count is ${ac.count}; rubric upper bound is ${MAX_ACS}. Split this into multiple issues.`,
      clarificationQuestion: `Trim to ≤ ${MAX_ACS} acceptance criteria, or split this into multiple issues each with its own bounded AC list.`,
    };
  }

  if (ac.blankEntries > 0) {
    return {
      gateId: 1,
      verdict: 'fail',
      severity: 'block',
      stage: 'A',
      confidence: 'high',
      finding: `${ac.blankEntries} acceptance criterion(a) are blank.`,
      clarificationQuestion: 'Fill in or remove the blank acceptance criterion entries.',
    };
  }

  // Stage A passes — Stage B (Phase 2b) will judge testability of each
  // surviving AC against the binary-testable rubric.
  return {
    gateId: 1,
    verdict: 'pass',
    severity: 'block',
    stage: 'A',
    confidence: 'medium',
  };
}
