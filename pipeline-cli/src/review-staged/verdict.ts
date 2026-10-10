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

import { STAGED_REVIEWER_NAME } from '../attestation/merkle.js';
import type { ReviewerFinding, ReviewerVerdict } from '../types.js';
import type { StagedVerdict } from '../review-synth/types.js';

/** Hunk ids named in the summary at most; the rest are counted. */
const MAX_LISTED = 20;

export function toReviewerVerdict(
  verdict: StagedVerdict,
  uncoveredHunks: readonly string[] = [],
): ReviewerVerdict {
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
  if (uncoveredHunks.length > 0) {
    const listed = uncoveredHunks.slice(0, MAX_LISTED).join(', ');
    const more =
      uncoveredHunks.length > MAX_LISTED ? ` and ${uncoveredHunks.length - MAX_LISTED} more` : '';
    notes.push(`Hunks with no probe evidence (not reviewed): ${listed}${more}.`);
  }
  return {
    agentId: STAGED_REVIEWER_NAME,
    harness: 'claude-code',
    approved: verdict.approved,
    findings,
    summary: notes.join(' '),
  };
}
