/**
 * One predicate for ship and resume (AISDLC-984): the head's patch id has a v6
 * attestation envelope under `.ai-sdlc/attestations/`. A head that fails it is never
 * "done"; the caller routes to the sign step.
 *
 * @module next-step/head-envelope
 */

import { computePatchId } from '../attestation/patch-id.js';
import { resolveTargetBranch } from '../steps/02-compute-branch.js';
import type { NextStepContext } from './types.js';

export type HeadEnvelopeStatus =
  | { status: 'present'; headSha: string; patchId: string; file: string }
  | { status: 'missing'; headSha: string; patchId: string; file: string; reason: string }
  /** The patch id cannot be computed (empty diff, shallow clone): legacy per-SHA naming applies. */
  | { status: 'unknown'; headSha: string };

export interface HeadEnvelopeOpts {
  /** Test injection: the head's patch id (default: computed against the target merge-base). */
  patchId?: (base: string, head: string, cwd: string) => string | null;
}

export async function checkHeadEnvelope(
  ctx: NextStepContext,
  cwd: string,
  opts: HeadEnvelopeOpts = {},
): Promise<HeadEnvelopeStatus> {
  const git = async (args: string[]): Promise<string | null> => {
    const r = await ctx.runner('git', args, { cwd, allowFailure: true });
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const headSha = (await git(['rev-parse', 'HEAD'])) ?? '';
  const target = `origin/${resolveTargetBranch(ctx.workDir)}`;
  const base = await git(['merge-base', target, 'HEAD']);
  const patchId = base ? (opts.patchId ?? computePatchId)(base, headSha, cwd) : null;
  if (!patchId) return { status: 'unknown', headSha };
  const file = `.ai-sdlc/attestations/${patchId}.v6.dsse.json`;
  if ((await git(['cat-file', '-e', `HEAD:${file}`])) !== null) {
    return { status: 'present', headSha, patchId, file };
  }
  return {
    status: 'missing',
    headSha,
    patchId,
    file,
    reason:
      `head ${headSha} has no v6 attestation envelope: looked for ${file} (patch id ${patchId}). ` +
      `Re-sign: run the sign step (sign-attestation-if-consumer.sh, or push so the pre-push hook signs), then re-run.`,
  };
}
