/**
 * The staged set's verdict in the shape Step 8 aggregates.
 *
 * The staged set produces one verdict where the three-reviewer set produces three.
 * Aggregation (`steps/08-aggregate-verdicts.ts`) already handles a set of any size: it
 * counts findings by severity and requires every participating verdict to approve, so
 * the blocking rules are the ones every other set gets.
 *
 * @module review-staged/verdict
 */

import { STAGED_REVIEWER_NAME } from '../attestation/staged-review.js';
import type { ReviewerFinding, ReviewerVerdict } from '../types.js';
import type { StagedVerdict, UncoveredHunkRef } from '../review-synth/types.js';
import { DEFAULT_HARNESS } from '../harness-defaults.js';

/** Hunk ids named in the summary at most; the rest are counted. */
const MAX_LISTED = 20;

interface CoverageHunk {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
}

/**
 * Fail closed on coverage (DEC-0040, RFC-0052). An uncovered high-risk hunk makes the
 * verdict `approved: false` with reason `incomplete-coverage` and the hunks listed by file
 * and line range. Uncovered medium and low risk hunks are listed but never flip the verdict.
 */
export function applyCoverageGate(
  verdict: StagedVerdict,
  hunks: readonly CoverageHunk[],
  uncoveredIds: readonly string[],
  isHigh: (hunk: CoverageHunk) => boolean,
): StagedVerdict {
  const uncovered = new Set(uncoveredIds);
  const refs: UncoveredHunkRef[] = hunks
    .filter((h) => uncovered.has(h.id))
    .map((h) => ({
      id: h.id,
      file: h.file,
      startLine: h.startLine,
      endLine: h.endLine,
      risk: isHigh(h) ? 'high' : 'other',
    }));
  if (refs.length === 0) return verdict;
  const blocked = refs.some((r) => r.risk === 'high');
  return {
    ...verdict,
    approved: verdict.approved && !blocked,
    uncoveredHunks: refs,
    ...(blocked ? { reason: 'incomplete-coverage' as const } : {}),
  };
}

export function toReviewerVerdict(
  verdict: StagedVerdict,
  uncoveredHunks: readonly string[] = [],
): ReviewerVerdict {
  const ranges = (verdict.uncoveredHunks ?? [])
    .filter((h) => h.risk === 'high')
    .map((h) => `${h.file}:${h.startLine}-${h.endLine}`);
  const findings: ReviewerFinding[] = verdict.findings.map((f) => ({
    severity: f.severity,
    ...(f.file ? { file: f.file } : {}),
    ...(typeof f.line === 'number' ? { line: f.line } : {}),
    message: f.message,
  }));
  const notes: string[] = [verdict.summary];
  if (verdict.groundingDropped && verdict.groundingDropped > 0) {
    notes.push(
      `${verdict.groundingDropped} finding(s) were dropped because no evidence backed them.`,
    );
  }
  if (verdict.reason === 'incomplete-coverage') {
    notes.push(`incomplete-coverage: high-risk hunks not reviewed: ${ranges.join(', ')}.`);
  }
  if (uncoveredHunks.length > 0) {
    const listed = uncoveredHunks.slice(0, MAX_LISTED).join(', ');
    const more =
      uncoveredHunks.length > MAX_LISTED ? ` and ${uncoveredHunks.length - MAX_LISTED} more` : '';
    notes.push(`Hunks with no probe evidence (not reviewed): ${listed}${more}.`);
  }
  return {
    agentId: STAGED_REVIEWER_NAME,
    harness: DEFAULT_HARNESS,
    approved: verdict.approved,
    findings,
    summary: notes.join(' '),
  };
}
