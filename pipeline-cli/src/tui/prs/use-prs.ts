/**
 * PRs pane logic — RFC-0023 §7.2 / AISDLC-178.4.
 *
 * Wraps `useGhPrs` from Phase 2 and applies the RFC §7.2 sort order:
 *   blocked-on-human > changes-requested > awaiting-rebase > in-progress > ready-to-merge
 *
 * Also derives display fields (CI glyph, review state label, merge state
 * label, next-step annotation, urgency colour) from the raw GhPrSummary.
 */

import type { GhPrSummary, UseGhPrsOpts, UseGhPrsState } from '../sources/gh-pr-cache.js';
import { useGhPrs } from '../sources/gh-pr-cache.js';

// ── Derived display fields ────────────────────────────────────────────────────

/**
 * CI status glyph per RFC §7.2:
 *   ✓  = SUCCESS
 *   ⏳ = PENDING (or unknown / no checks yet)
 *   ✗  = FAILURE / ERROR
 */
export type CiGlyph = '✓' | '⏳' | '✗';

export function ciGlyph(pr: GhPrSummary): CiGlyph {
  const rollup = pr.statusCheckRollup;
  if (rollup === null || rollup === undefined) return '⏳';
  const status = typeof rollup === 'string' ? rollup : ((rollup as { state?: string }).state ?? '');
  const normalized = status.toUpperCase();
  if (normalized === 'SUCCESS') return '✓';
  if (normalized === 'FAILURE' || normalized === 'ERROR') return '✗';
  return '⏳';
}

/**
 * Review state label per RFC §7.2:
 *   approved | changes-requested | pending | no-reviews-yet
 */
export type ReviewStateLabel = 'approved' | 'changes-requested' | 'pending' | 'no-reviews-yet';

export function reviewStateLabel(pr: GhPrSummary): ReviewStateLabel {
  const decision = (pr as unknown as { reviewDecision?: string }).reviewDecision;
  if (!decision) return 'no-reviews-yet';
  const upper = decision.toUpperCase();
  if (upper === 'APPROVED') return 'approved';
  if (upper === 'CHANGES_REQUESTED') return 'changes-requested';
  if (upper === 'REVIEW_REQUIRED') return 'pending';
  return 'no-reviews-yet';
}

/**
 * Merge state label per RFC §7.2:
 *   clean | behind | dirty | blocked
 */
export type MergeStateLabel = 'clean' | 'behind' | 'dirty' | 'blocked';

export function mergeStateLabel(pr: GhPrSummary): MergeStateLabel {
  const mergeable = pr.mergeable?.toUpperCase();
  if (mergeable === 'CONFLICTING') return 'dirty';
  // mergeStateStatus is not part of our JSON fields, so we derive "behind"
  // from context: MERGEABLE + ci != success → ambiguous, but we default to clean.
  // The GhPrSummary interface exposes `mergeable`; behind is derived when
  // the PR branch is detected as out-of-date — not available in the basic
  // gh pr list JSON. We fall back to 'clean' unless blocked.
  if (mergeable === 'BLOCKED') return 'blocked';
  if (mergeable === 'BEHIND') return 'behind';
  if (mergeable === 'MERGEABLE') return 'clean';
  return 'clean';
}

/**
 * Next-step annotation per RFC §7.2:
 *   awaiting-ci | ready-to-merge | awaiting-human | awaiting-rebase
 */
export type NextStepLabel = 'awaiting-ci' | 'ready-to-merge' | 'awaiting-human' | 'awaiting-rebase';

export function nextStepLabel(pr: GhPrSummary): NextStepLabel {
  const review = reviewStateLabel(pr);
  const ci = ciGlyph(pr);
  const merge = mergeStateLabel(pr);

  if (merge === 'dirty' || merge === 'behind') return 'awaiting-rebase';
  if (merge === 'blocked') return 'awaiting-ci';
  if (review === 'changes-requested') return 'awaiting-human';
  if (review === 'approved' && ci === '✓') return 'ready-to-merge';
  if (ci === '⏳') return 'awaiting-ci';
  if (ci === '✗') return 'awaiting-human';
  if (review === 'pending' || review === 'no-reviews-yet') return 'awaiting-human';
  return 'awaiting-ci';
}

/**
 * Urgency colour per RFC §7.2:
 *   red     = blocked (merge dirty/behind or changes-requested)
 *   yellow  = in-progress (CI pending)
 *   green   = ready-to-merge
 *   gray    = no-attention-needed (no reviews yet, not actively progressing)
 */
export type UrgencyColor = 'red' | 'yellow' | 'green' | 'gray';

export function urgencyColor(pr: GhPrSummary): UrgencyColor {
  const next = nextStepLabel(pr);
  const ci = ciGlyph(pr);
  const review = reviewStateLabel(pr);

  if (next === 'ready-to-merge') return 'green';
  if (next === 'awaiting-rebase') return 'red';
  if (review === 'changes-requested') return 'red';
  if (ci === '✗') return 'red';
  if (ci === '⏳') return 'yellow';
  if (review === 'no-reviews-yet') return 'gray';
  return 'yellow';
}

// ── Sort order ───────────────────────────────────────────────────────────────

/**
 * Sort bucket for operator-attention ordering per RFC §7.2:
 *   0 = blocked-on-human (highest attention required)
 *   1 = changes-requested
 *   2 = awaiting-rebase
 *   3 = in-progress (ci pending)
 *   4 = ready-to-merge (lowest: no action needed from operator)
 */
export function prSortBucket(pr: GhPrSummary): number {
  const review = reviewStateLabel(pr);
  const ci = ciGlyph(pr);
  const merge = mergeStateLabel(pr);
  const next = nextStepLabel(pr);

  // ready-to-merge: no attention needed, sort last
  if (next === 'ready-to-merge') return 4;
  // in-progress (CI running): operator may be unblocked soon
  if (ci === '⏳' && merge === 'clean' && review !== 'changes-requested') return 3;
  // awaiting-rebase: operator action needed (or CI action)
  if (next === 'awaiting-rebase') return 2;
  // changes-requested: explicit operator attention
  if (review === 'changes-requested') return 1;
  // blocked-on-human: everything else the operator needs to handle
  return 0;
}

/**
 * Derived row ready for the PRs pane to render.
 */
export interface PrRow {
  pr: GhPrSummary;
  ci: CiGlyph;
  review: ReviewStateLabel;
  merge: MergeStateLabel;
  nextStep: NextStepLabel;
  color: UrgencyColor;
  /** Sort bucket (0 = highest attention, 4 = lowest). */
  bucket: number;
}

/**
 * Build sorted PR rows from a raw list.
 * Sort: bucket ASC (0 = most urgent), then PR number DESC (newest first within bucket).
 */
export function buildPrRows(prs: GhPrSummary[]): PrRow[] {
  return prs
    .map((pr) => ({
      pr,
      ci: ciGlyph(pr),
      review: reviewStateLabel(pr),
      merge: mergeStateLabel(pr),
      nextStep: nextStepLabel(pr),
      color: urgencyColor(pr),
      bucket: prSortBucket(pr),
    }))
    .sort((a, b) => {
      if (a.bucket !== b.bucket) return a.bucket - b.bucket;
      // Secondary: newest PR first
      return b.pr.number - a.pr.number;
    });
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UsePrsState {
  rows: PrRow[];
  error: import('../sources/types.js').SourceErrorKind | null;
  lastFetched: Date | null;
  invalidate: () => void;
}

/**
 * React hook — wraps `useGhPrs` and exposes sorted `PrRow[]` ready for
 * the PRs pane to render.
 */
export function usePrs(opts: UseGhPrsOpts = {}): UsePrsState {
  const { data, error, lastFetched, invalidate }: UseGhPrsState = useGhPrs(opts);
  const rows = buildPrRows(data ?? []);
  return { rows, error, lastFetched, invalidate };
}
