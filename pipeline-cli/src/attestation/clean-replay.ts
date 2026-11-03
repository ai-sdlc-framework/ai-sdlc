/**
 * RFC-0061 Phase 1 (OQ-2, OQ-5): the single clean-replay carry-forward rule. A verdict recorded
 * for a reviewed head carries forward to a candidate head when the candidate is the same change
 * replayed cleanly: either an identical tree (message-only amend), or a conflict-free three-way
 * replay of the reviewed head onto the candidate base whose tree equals the candidate's tree.
 *
 * `merge_group` is deliberately NOT wired (OQ-5). When the merge queue returns, the queue's
 * synthetic head must be checked with this same function against the PR's verdict record; a
 * direct squash merge of a behind head is a clean three-way replay that GitHub itself refuses on
 * conflict, so no separate check is needed there (see docs/operations/merge-without-queue.md).
 *
 * No path writes a new verdict ref for a carried-forward head.
 *
 * @module attestation/clean-replay
 */

import type { Runner } from '../runtime/exec.js';

/** `git merge-tree --write-tree` first shipped in git 2.38 with `--merge-base` in 2.40. */
export const MIN_GIT_VERSION = [2, 40] as const;

export interface ReplaySubject {
  headSha: string;
  baseSha: string;
}

export class GitTooOldError extends Error {
  readonly code = 'git-too-old';
  constructor(found: string) {
    super(
      `clean-replay carry-forward requires git ${MIN_GIT_VERSION.join('.')} or later (found ${found || 'unknown'})`,
    );
    this.name = 'GitTooOldError';
  }
}

/** Parse `git version 2.43.0` (and vendor suffixes) into [major, minor], or null. */
export function parseGitVersion(out: string): [number, number] | null {
  const m = /(\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export async function assertGitSupportsMergeTree(runner: Runner, cwd: string): Promise<void> {
  const r = await runner('git', ['--version'], { cwd, allowFailure: true });
  const v = r.code === 0 ? parseGitVersion(r.stdout) : null;
  if (
    !v ||
    v[0] < MIN_GIT_VERSION[0] ||
    (v[0] === MIN_GIT_VERSION[0] && v[1] < MIN_GIT_VERSION[1])
  ) {
    throw new GitTooOldError(r.stdout.trim());
  }
}

async function treeOf(runner: Runner, cwd: string, sha: string): Promise<string | null> {
  const r = await runner('git', ['rev-parse', `${sha}^{tree}`], { cwd, allowFailure: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** True when the candidate is a clean replay of the reviewed change. Throws GitTooOldError on git < 2.40. */
export async function cleanReplayCarriesForward(
  runner: Runner,
  cwd: string,
  reviewed: ReplaySubject,
  candidate: ReplaySubject,
): Promise<boolean> {
  await assertGitSupportsMergeTree(runner, cwd);
  const [reviewedTree, candidateTree] = await Promise.all([
    treeOf(runner, cwd, reviewed.headSha),
    treeOf(runner, cwd, candidate.headSha),
  ]);
  if (!reviewedTree || !candidateTree) return false;
  if (reviewedTree === candidateTree) return true;
  const merged = await runner(
    'git',
    [
      'merge-tree',
      '--write-tree',
      `--merge-base=${reviewed.baseSha}`,
      candidate.baseSha,
      reviewed.headSha,
    ],
    { cwd, allowFailure: true },
  );
  if (merged.code !== 0) return false;
  const tree = merged.stdout.split('\n')[0]?.trim();
  return tree === candidateTree;
}

export type CarryForwardResult =
  { status: 'ok-carried'; from: string } | { status: 'replay-dirty' };

/**
 * Called by the verdict check when no record exists for the head: walks the earlier records for
 * the same PR (newest first) and reports `ok-carried:<sha>` for the first clean replay.
 */
export async function findCarriedVerdict(
  runner: Runner,
  cwd: string,
  candidate: ReplaySubject,
  earlier: ReadonlyArray<ReplaySubject>,
): Promise<CarryForwardResult> {
  for (const reviewed of earlier) {
    if (reviewed.headSha === candidate.headSha) continue;
    if (await cleanReplayCarriesForward(runner, cwd, reviewed, candidate)) {
      return { status: 'ok-carried', from: reviewed.headSha };
    }
  }
  return { status: 'replay-dirty' };
}
