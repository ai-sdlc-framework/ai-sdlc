/**
 * PRs pane logic — RFC-0023 §7.2 / AISDLC-178.4 + AISDLC-178.4.1.
 *
 * Wraps `useGhPrs` from Phase 2 and applies the AC #2 sort order:
 *   critical-path-length DESC → unblock-count DESC → effPri DESC → age ASC
 *
 * Also exposes legacy sort modes (`recency`, `ci-status`) so the `s`
 * keystroke can cycle between them per AC #5. The original "operator
 * attention" bucket sort lives on as the `ci-status` mode for back-compat.
 *
 * Derived display fields per RFC §7.2: CI glyph, review state label, merge
 * state label, next-step annotation, urgency colour, plus AISDLC-178.4.1's
 * `chain` info (upstream/downstream PR numbers, cpl, unblock count, chain
 * position/length).
 */

import type { GhPrSummary, UseGhPrsOpts, UseGhPrsState } from '../sources/gh-pr-cache.js';
import { useGhPrs } from '../sources/gh-pr-cache.js';
import type { SnapshotRecord } from '../../deps/snapshot.js';
import {
  derivePrChainGraph,
  extractTaskId,
  type PrAncestryChecker,
  type PrChainGraph,
  type PrChainInfo,
} from './critical-path.js';
import { DEFAULT_PRIORITY_WEIGHT } from '../../deps/effective-priority.js';

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
  const decision = pr.reviewDecision;
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

// ── Sort buckets (legacy `ci-status` mode) ────────────────────────────────────

/**
 * Sort bucket for operator-attention ordering per RFC §7.2 (AISDLC-178.4):
 *   0 = blocked-on-human (highest attention required)
 *   1 = changes-requested
 *   2 = awaiting-rebase
 *   3 = in-progress (ci pending)
 *   4 = ready-to-merge (lowest: no action needed from operator)
 *
 * Drives the `ci-status` sort mode (AISDLC-178.4.1 AC #5).
 */
export function prSortBucket(pr: GhPrSummary): number {
  const review = reviewStateLabel(pr);
  const ci = ciGlyph(pr);
  const merge = mergeStateLabel(pr);
  const next = nextStepLabel(pr);

  if (next === 'ready-to-merge') return 4;
  if (ci === '⏳' && merge === 'clean' && review !== 'changes-requested') return 3;
  if (next === 'awaiting-rebase') return 2;
  if (review === 'changes-requested') return 1;
  return 0;
}

// ── Derived row ───────────────────────────────────────────────────────────────

/** Derived row ready for the PRs pane to render. */
export interface PrRow {
  pr: GhPrSummary;
  ci: CiGlyph;
  review: ReviewStateLabel;
  merge: MergeStateLabel;
  nextStep: NextStepLabel;
  color: UrgencyColor;
  /** Sort bucket (0 = highest attention, 4 = lowest). Drives `ci-status` mode. */
  bucket: number;
  /**
   * AISDLC-178.4.1 — chain info derived from `derivePrChainGraph`. When the
   * dep snapshot isn't available + the PR has no depends-on labels/body, this
   * is the singleton record (cpl=0, unblockCount=0, chainLen=1).
   */
  chain: PrChainInfo;
  /**
   * effectivePriority lifted from the snapshot record matching this PR's
   * task ID. Falls back to {@link DEFAULT_PRIORITY_WEIGHT} when no record
   * is present (PR has no task-id branch, snapshot stale, etc). Used as the
   * tertiary sort key in `critical-path` mode.
   */
  effPri: number;
}

// ── Sort modes ────────────────────────────────────────────────────────────────

/**
 * Sort modes cycled by the `s` keystroke per AC #5:
 *   critical-path → recency → ci-status → critical-path
 */
export type PrSortMode = 'critical-path' | 'recency' | 'ci-status';

export const PR_SORT_MODES: readonly PrSortMode[] = ['critical-path', 'recency', 'ci-status'];

/** Step the sort cycle one position forward. */
export function nextSortMode(current: PrSortMode): PrSortMode {
  const idx = PR_SORT_MODES.indexOf(current);
  return PR_SORT_MODES[(idx + 1) % PR_SORT_MODES.length] ?? 'critical-path';
}

/**
 * Sort rows according to the active mode. Always returns a fresh array
 * (does not mutate input).
 *
 * `critical-path` (AC #2): cpl DESC → unblockCount DESC → effPri DESC → age ASC (createdAt ASC)
 * `recency`              : updatedAt DESC → number DESC
 * `ci-status` (legacy)   : bucket ASC → number DESC
 */
export function sortPrRows(rows: PrRow[], mode: PrSortMode): PrRow[] {
  const out = [...rows];
  switch (mode) {
    case 'critical-path':
      out.sort((a, b) => {
        if (a.chain.cpl !== b.chain.cpl) return b.chain.cpl - a.chain.cpl;
        if (a.chain.unblockCount !== b.chain.unblockCount) {
          return b.chain.unblockCount - a.chain.unblockCount;
        }
        if (a.effPri !== b.effPri) return b.effPri - a.effPri;
        const ageA = a.pr.createdAt;
        const ageB = b.pr.createdAt;
        if (ageA !== ageB) return ageA < ageB ? -1 : 1;
        return a.pr.number - b.pr.number;
      });
      return out;
    case 'recency':
      out.sort((a, b) => {
        const updA = a.pr.updatedAt;
        const updB = b.pr.updatedAt;
        if (updA !== updB) return updA < updB ? 1 : -1;
        return b.pr.number - a.pr.number;
      });
      return out;
    case 'ci-status':
      out.sort((a, b) => {
        if (a.bucket !== b.bucket) return a.bucket - b.bucket;
        return b.pr.number - a.pr.number;
      });
      return out;
  }
}

// ── Row builder ───────────────────────────────────────────────────────────────

export interface BuildPrRowsOpts {
  /** Sort mode. Defaults to `critical-path` per AC #2. */
  mode?: PrSortMode;
  /** Optional dep-snapshot records for task-dep edge derivation. */
  snapshotRecords?: SnapshotRecord[];
  /** Optional git ancestry checker — see `derivePrChainGraph`. */
  gitAncestry?: PrAncestryChecker;
}

/**
 * Build sorted PR rows from a raw list. `mode` defaults to `critical-path`.
 *
 * Each row is enriched with chain info (cpl, unblockCount, chain position)
 * and the snapshot's effective priority for the matching task. PRs whose
 * branch carries no recognisable task ID still get a singleton chain record
 * (cpl=0, chainLen=1) and the default priority weight.
 */
export function buildPrRows(prs: GhPrSummary[], opts: BuildPrRowsOpts = {}): PrRow[] {
  const mode: PrSortMode = opts.mode ?? 'critical-path';
  const graph: PrChainGraph = derivePrChainGraph({
    prs,
    snapshotRecords: opts.snapshotRecords,
    gitAncestry: opts.gitAncestry,
  });

  // Build task-id → effectivePriority lookup once.
  const effByTask = new Map<string, number>();
  for (const record of opts.snapshotRecords ?? []) {
    effByTask.set(record.id.toLowerCase(), record.effectivePriority ?? DEFAULT_PRIORITY_WEIGHT);
  }

  const rows: PrRow[] = prs.map((pr) => {
    const taskId = extractTaskId(pr.headRefName);
    const effPri =
      taskId && effByTask.has(taskId.toLowerCase())
        ? (effByTask.get(taskId.toLowerCase()) ?? DEFAULT_PRIORITY_WEIGHT)
        : DEFAULT_PRIORITY_WEIGHT;
    const chain = graph.info.get(pr.number) ?? {
      upstream: [],
      downstream: [],
      cpl: 0,
      unblockCount: 0,
      chainPos: 1,
      chainLen: 1,
      inChain: false,
    };
    return {
      pr,
      ci: ciGlyph(pr),
      review: reviewStateLabel(pr),
      merge: mergeStateLabel(pr),
      nextStep: nextStepLabel(pr),
      color: urgencyColor(pr),
      bucket: prSortBucket(pr),
      chain,
      effPri,
    };
  });

  return sortPrRows(rows, mode);
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UsePrsOpts extends UseGhPrsOpts {
  /** Snapshot records (optional) for chain derivation. */
  snapshotRecords?: SnapshotRecord[];
  /** Git ancestry checker (optional) — see `derivePrChainGraph`. */
  gitAncestry?: PrAncestryChecker;
}

export interface UsePrsState {
  rows: PrRow[];
  /**
   * Chain graph for the currently-rendered rows. Exposed so the pane's
   * detail view can render the ASCII chain tree without recomputing.
   */
  graph: PrChainGraph;
  error: import('../sources/types.js').SourceErrorKind | null;
  lastFetched: Date | null;
  invalidate: () => void;
  /** Raw PR list (post-fetch, pre-sort) — exposed for `sortPrRows` consumers. */
  prs: GhPrSummary[];
}

/**
 * React hook — wraps `useGhPrs` and exposes critical-path-sorted `PrRow[]`
 * + the underlying chain graph. Sort mode is fixed to `critical-path` here;
 * the pane component manages mode cycling locally so the hook stays
 * cheap to call.
 */
export function usePrs(opts: UsePrsOpts = {}): UsePrsState {
  const { data, error, lastFetched, invalidate }: UseGhPrsState = useGhPrs(opts);
  const prs = data ?? [];
  const graph = derivePrChainGraph({
    prs,
    snapshotRecords: opts.snapshotRecords,
    gitAncestry: opts.gitAncestry,
  });
  const rows = buildPrRows(prs, {
    mode: 'critical-path',
    snapshotRecords: opts.snapshotRecords,
    gitAncestry: opts.gitAncestry,
  });
  return { rows, graph, error, lastFetched, invalidate, prs };
}
