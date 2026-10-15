/**
 * Rebase-only re-arm predicate (AISDLC-872).
 *
 * A force-push after a rebase dismisses the GitHub review and disarms
 * auto-merge even when the content is unchanged. The attestation is already
 * keyed on patch-id, so the content proof survives; this predicate answers the
 * one question that decides whether re-arming without a fresh review is safe:
 * "is the patch-id of the new head equal to the patch-id of the previously
 * armed head?". It never merges or arms anything itself; the caller routes the
 * re-arm through `cli-merge-if-eligible --arm` and its full eligibility checks.
 *
 * @module governance/rebase-rearm
 */

import { computeMergeBase, computePatchId } from '../attestation/patch-id.js';

export interface RebaseOnlyResult {
  /** True only when both patch-ids were computed and are identical. */
  rebaseOnly: boolean;
  reason: string;
}

export interface RebaseOnlyDeps {
  mergeBase?: typeof computeMergeBase;
  patchId?: typeof computePatchId;
}

/**
 * Compare the content patch-id of `previousHead` and `newHead`, each against
 * its own merge-base with `baseRef`. Fails closed: any null patch-id (empty
 * diff, unreachable object) means "not provably rebase-only".
 */
export function isRebaseOnlyPush(args: {
  previousHead: string;
  newHead: string;
  repoRoot: string;
  baseRef?: string;
  deps?: RebaseOnlyDeps;
}): RebaseOnlyResult {
  const baseRef = args.baseRef ?? 'origin/main';
  const mergeBase = args.deps?.mergeBase ?? computeMergeBase;
  const patchId = args.deps?.patchId ?? computePatchId;
  const { previousHead, newHead, repoRoot } = args;

  if (previousHead.toLowerCase() === newHead.toLowerCase()) {
    return { rebaseOnly: true, reason: 'head unchanged' };
  }
  const prevBase = mergeBase(baseRef, previousHead, repoRoot);
  const newBase = mergeBase(baseRef, newHead, repoRoot);
  if (!prevBase || !newBase) {
    return { rebaseOnly: false, reason: 'could not resolve merge-base; not re-arming' };
  }
  const prevId = patchId(prevBase, previousHead, repoRoot);
  const newId = patchId(newBase, newHead, repoRoot);
  if (!prevId || !newId) {
    return { rebaseOnly: false, reason: 'could not compute patch-id; not re-arming' };
  }
  return prevId === newId
    ? { rebaseOnly: true, reason: `patch-id unchanged (${newId})` }
    : {
        rebaseOnly: false,
        reason: `patch-id changed (${prevId} -> ${newId}); a fresh review and arm are required`,
      };
}
