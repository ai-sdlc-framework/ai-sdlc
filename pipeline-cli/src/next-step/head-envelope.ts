/**
 * One predicate for resume (AISDLC-984, RFC-0061 Phase 2): the head has a review verdict, either
 * a record under `refs/ai-sdlc/verdicts/<head>` on the remote or an earlier approved record the
 * clean-replay rule carries forward (AISDLC-1170). A head with neither needs review, never a
 * signing step: nothing on this path produces or demands a v6 envelope.
 *
 * @module next-step/head-envelope
 */

import { makeCarryForward } from '../attestation/verdict-cli.js';
import { verdictRefName } from '../attestation/verdict-record.js';
import { resolveTargetBranch } from '../steps/02-compute-branch.js';
import type { NextStepContext } from './types.js';

export type HeadVerdictStatus =
  | { status: 'present'; headSha: string; ref: string }
  | { status: 'carried'; headSha: string; from: string }
  | { status: 'missing'; headSha: string; ref: string; reason: string }
  /** HEAD or the merge-base cannot be resolved: the caller treats the head as needing review. */
  | { status: 'unknown'; headSha: string };

export async function checkHeadVerdict(
  ctx: Pick<NextStepContext, 'workDir' | 'runner'>,
  cwd: string,
  opts: { pullRequest?: number } = {},
): Promise<HeadVerdictStatus> {
  const git = async (args: string[]): Promise<string | null> => {
    const r = await ctx.runner('git', args, { cwd, allowFailure: true, timeout: 60_000 });
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const headSha = (await git(['rev-parse', 'HEAD'])) ?? '';
  const target = `origin/${resolveTargetBranch(ctx.workDir)}`;
  const base = await git(['merge-base', target, 'HEAD']);
  if (!headSha || !base) return { status: 'unknown', headSha };
  const ref = verdictRefName(headSha);
  if (await git(['ls-remote', 'origin', ref])) return { status: 'present', headSha, ref };
  const carried = await makeCarryForward(ctx.runner, cwd, base, opts.pullRequest)(headSha);
  if (carried) return { status: 'carried', headSha, from: carried.from };
  return {
    status: 'missing',
    headSha,
    ref,
    reason: `head ${headSha} has no verdict record (${ref}) and no earlier approved record carries forward; it needs review`,
  };
}
