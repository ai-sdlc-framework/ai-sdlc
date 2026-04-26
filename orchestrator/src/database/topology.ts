/**
 * Branch topology guard per RFC §15.5.1 (Q15 resolution). Defaults `allowBranchFromBranch`
 * to false, refusing to allocate a branch whose upstream is itself an in-flight feature
 * branch. Eliminates MigrationDiverged for ~95% of pipelines that don't need stacked PRs.
 */

import { BranchTopologyForbiddenError, type ResolvedDatabaseBranchPool } from './types.js';

export interface KnownInFlightBranches {
  /** Branch names currently allocated as DatabaseBranch handles in this pool. */
  inFlightBranchNames: Set<string>;
  /** Stable upstream branch names the operator considers safe to branch from. */
  stableUpstreams: Set<string>;
}

/**
 * Validate a branchFrom request against the topology guard. Throws
 * BranchTopologyForbiddenError if the upstream is an in-flight branch and
 * `allowBranchFromBranch` is false.
 */
export function enforceTopologyGuard(
  pool: ResolvedDatabaseBranchPool,
  state: KnownInFlightBranches,
): void {
  const branchFrom = pool.upstream.branchFrom;
  if (!branchFrom) return;

  // Always allowed when the upstream is a declared stable branch.
  if (state.stableUpstreams.has(branchFrom)) return;

  if (state.inFlightBranchNames.has(branchFrom)) {
    if (pool.allowBranchFromBranch !== true) {
      throw new BranchTopologyForbiddenError(
        `DatabaseBranchPool '${pool.name}' attempted to branch from in-flight branch '${branchFrom}'; ` +
          `set allowBranchFromBranch: true to opt in to chained branching (and accept MigrationDiverged risk).`,
        pool.name,
      );
    }
  }
}

/**
 * MigrationDiverged event payload per RFC §15.5.1. Emitted by the orchestrator when a
 * branch with active children is reclaimed (parent PR abandoned).
 */
export interface MigrationDivergedEvent {
  type: 'MigrationDiverged';
  reclaimedBranch: {
    branchKey: string;
    reason: 'pr-abandoned' | 'manual-reclaim' | 'ttl-expired';
    issueId?: string;
  };
  divergentChildren: Array<{
    branchKey: string;
    issueId?: string;
    lastActivity: string;
  }>;
  interpretation: string;
  recommendation: string;
}

/**
 * Build a MigrationDiverged event from the parent reclaim + a snapshot of children.
 * The orchestrator emits this through its event stream; the operator triages per
 * the runbook. NO auto-action.
 */
export function buildMigrationDivergedEvent(
  parent: {
    branchKey: string;
    reason: 'pr-abandoned' | 'manual-reclaim' | 'ttl-expired';
    issueId?: string;
  },
  children: Array<{ branchKey: string; issueId?: string; lastActivity: Date }>,
): MigrationDivergedEvent {
  return {
    type: 'MigrationDiverged',
    reclaimedBranch: parent,
    divergentChildren: children.map((c) => ({
      branchKey: c.branchKey,
      issueId: c.issueId,
      lastActivity: c.lastActivity.toISOString(),
    })),
    interpretation:
      'child branches inherit a migration that no longer exists in any merged code. Their PRs may pass tests but break on merge to main.',
    recommendation:
      'operator triage: rebase children onto current upstream, accept divergence, or reclaim children. The orchestrator does NOT auto-rebase or auto-reclaim.',
  };
}
