/**
 * Rebase-only re-arm predicate (AISDLC-872, RFC-0061 Phase 2).
 *
 * A force-push after a rebase dismisses the GitHub review and disarms auto-merge even when the
 * content is unchanged. The review verdict now lives in a ref outside the branch, so this
 * predicate asks the single clean-replay carry-forward rule (AISDLC-1170) whether the new head
 * is the previously armed head replayed cleanly. No patch-id is compared. It never merges or
 * arms anything itself; the caller routes the re-arm through `cli-merge-if-eligible --arm` and
 * its full eligibility checks.
 *
 * @module governance/rebase-rearm
 */

import { cleanReplayCarriesForward, GitTooOldError } from '../attestation/clean-replay.js';
import type { Runner } from '../runtime/exec.js';

export interface RebaseOnlyResult {
  /** True only when the new head is a clean replay of the previous head. */
  rebaseOnly: boolean;
  reason: string;
}

/**
 * Fails closed: an unresolvable merge-base, a dirty replay or an old git means "not provably
 * rebase-only".
 */
export async function isRebaseOnlyPush(args: {
  previousHead: string;
  newHead: string;
  repoRoot: string;
  runner: Runner;
  baseRef?: string;
}): Promise<RebaseOnlyResult> {
  const baseRef = args.baseRef ?? 'origin/main';
  const { previousHead, newHead, repoRoot, runner } = args;
  if (previousHead.toLowerCase() === newHead.toLowerCase()) {
    return { rebaseOnly: true, reason: 'head unchanged' };
  }
  const baseOf = async (head: string): Promise<string | null> => {
    const r = await runner('git', ['merge-base', baseRef, head], {
      cwd: repoRoot,
      allowFailure: true,
    });
    const sha = r.stdout.trim();
    return r.code === 0 && sha ? sha : null;
  };
  const [prevBase, newBase] = await Promise.all([baseOf(previousHead), baseOf(newHead)]);
  if (!prevBase || !newBase) {
    return { rebaseOnly: false, reason: 'could not resolve merge-base; not re-arming' };
  }
  try {
    const carried = await cleanReplayCarriesForward(
      runner,
      repoRoot,
      { headSha: previousHead, baseSha: prevBase },
      { headSha: newHead, baseSha: newBase },
    );
    return carried
      ? { rebaseOnly: true, reason: 'clean replay of the previously armed head' }
      : {
          rebaseOnly: false,
          reason: 'not a clean replay; a fresh review and arm are required',
        };
  } catch (err) {
    if (err instanceof GitTooOldError) return { rebaseOnly: false, reason: err.message };
    throw err;
  }
}
