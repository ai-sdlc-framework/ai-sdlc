/**
 * `StackedPRBaseSquashed` handler (RFC-0015 §5.1, row 9 — post-iteration
 * addition per Q9 resolution).
 *
 * Detection: previously-opened PR's `mergeStateStatus` flips to `DIRTY`
 * AND base PR was merged via a non-merge-commit strategy (squash OR
 * rebase — both rewrite SHAs and orphan the child branch's parent
 * commits). Detection requires BOTH the DIRTY state AND a `basePrMergedAt`
 * timestamp.
 *
 * Remediation: `git fetch origin main && git rebase origin/main`. Git's
 * `--reapply-cherry-picks` correctly skips the squashed/rebased-out
 * commits; the resulting history is clean. Then `--force-with-lease`
 * push.
 *
 * Budget: 1.
 */

import type { Handler, RemediationOutcome, WorkerContext, HandlerDeps } from '../types.js';

export const stackedPrBaseSquashedHandler: Handler = {
  mode: 'StackedPRBaseSquashed',
  budget: 1,
  detect(ctx: WorkerContext): boolean {
    if (!ctx.prUrl) return false;
    const isDirty = (ctx.failure.mergeStateStatus ?? '').toUpperCase() === 'DIRTY';
    const baseMerged = !!ctx.failure.basePrMergedAt;
    return isDirty && baseMerged;
  },
  async remediate(ctx: WorkerContext, deps: HandlerDeps): Promise<RemediationOutcome> {
    // Budget enforced by playbook-runner — handler is per-attempt only.
    deps.logger.warn(
      `[playbook/stacked-pr] rebasing ${ctx.branch} onto origin/main (base PR merged at ${ctx.failure.basePrMergedAt})`,
    );
    const fetch = await deps.runner('git', ['fetch', 'origin', 'main'], {
      cwd: ctx.worktreePath,
      allowFailure: true,
    });
    if (fetch.code !== 0) {
      return {
        status: 'budget-exhausted',
        note: `git fetch failed: ${fetch.stderr.slice(0, 200)}`,
      };
    }
    const rebase = await deps.runner('git', ['rebase', '--reapply-cherry-picks', 'origin/main'], {
      cwd: ctx.worktreePath,
      allowFailure: true,
    });
    if (rebase.code !== 0) {
      // Rebase conflict — escalate per §5.1 ("Manual review on rebase
      // conflicts. Alt: open a fresh PR from rebased branch with base=main").
      return {
        status: 'budget-exhausted',
        note: `rebase failed (likely conflicts): ${rebase.stderr.slice(0, 200)}`,
      };
    }
    const push = await deps.runner('git', ['push', '--force-with-lease', 'origin', ctx.branch], {
      cwd: ctx.worktreePath,
      allowFailure: true,
    });
    if (push.code === 0) {
      return {
        status: 'recovered',
        nextState: 'FINALIZING',
        note: 'rebased onto main + force-pushed; squashed parent commits dropped',
      };
    }
    return {
      status: 'budget-exhausted',
      note: `force-with-lease push failed after rebase: ${push.stderr.slice(0, 200)}`,
    };
  },
};
