/**
 * One eligibility rule for `.worktrees/*` (AISDLC-1108), shared by the dispatch
 * tick sweep (`00-sweep.ts`), `cli-hierarchy status` and `/ai-sdlc:cleanup`, so
 * the automatic and the manual path agree.
 *
 * A removed worktree loses nothing: the branch survives locally and on origin and
 * a resume recreates the directory from it. Branches are never deleted here.
 *
 * @module steps/00-worktree-disposition
 */

export type WorktreeDisposition =
  | 'keep-inflight'
  | 'keep-open-pr'
  | 'remove-merged'
  | 'remove-closed'
  | 'remove-no-pr'
  | 'remove-stale';

export interface WorktreeSweepConfig {
  /** Run the sweep every N ticks (default 1, every tick). */
  sweepEveryTicks: number;
  /** `cli-hierarchy status` alarms above this many worktree directories. */
  ceiling: number;
  /** A branch with no PR is kept while its directory is younger than this. */
  noPrGraceMs: number;
  /** An open-PR worktree whose branch head has not moved for this long is removed. */
  staleMs: number;
  /** A `.active-task` sentinel younger than this keeps the worktree. */
  sentinelMs: number;
}

const HOUR_MS = 3_600_000;

export const WORKTREE_SWEEP_DEFAULTS: WorktreeSweepConfig = {
  sweepEveryTicks: 1,
  ceiling: 40,
  noPrGraceMs: 6 * HOUR_MS,
  staleMs: 14 * 24 * HOUR_MS,
  sentinelMs: 24 * HOUR_MS,
};

export interface WorktreeFacts {
  /** The worktree's task id is on the board as inflight. */
  onBoardInflight: boolean;
  /** Age of the `.active-task` sentinel in the directory; null when there is none. */
  sentinelAgeMs: number | null;
  /** PR state for the branch; null means the branch has no PR. */
  prState: 'OPEN' | 'MERGED' | 'CLOSED' | null;
  /** Age of the directory's mtime. */
  dirAgeMs: number;
  /** Age of the branch head commit; null when unknown (an unknown age is never stale). */
  headAgeMs: number | null;
}

/** Classify one worktree. Pure: every input is a fact the caller already read. */
export function worktreeDisposition(
  f: WorktreeFacts,
  config: WorktreeSweepConfig = WORKTREE_SWEEP_DEFAULTS,
): WorktreeDisposition {
  if (f.onBoardInflight) return 'keep-inflight';
  if (f.sentinelAgeMs !== null && f.sentinelAgeMs < config.sentinelMs) return 'keep-inflight';
  if (f.prState === 'MERGED') return 'remove-merged';
  if (f.prState === 'CLOSED') return 'remove-closed';
  if (f.prState === 'OPEN') {
    return f.headAgeMs !== null && f.headAgeMs > config.staleMs ? 'remove-stale' : 'keep-open-pr';
  }
  // No PR: a developer pass that has not pushed yet is still in flight until the grace passes.
  return f.dirAgeMs > config.noPrGraceMs ? 'remove-no-pr' : 'keep-inflight';
}

export const isRemoval = (d: WorktreeDisposition): boolean => d.startsWith('remove-');
