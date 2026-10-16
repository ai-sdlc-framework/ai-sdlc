/**
 * Resume review decision (AISDLC-947).
 *
 * One decision at the top of a resume: compare the patch id of the current tree with the
 * patch id of the newest attestation envelope on the branch (the envelope filename is the
 * attested patch id; `subject.digest.sha1` is the attested head). No new state file.
 *
 *   - `unchanged`: equal patch ids. No developer and no reviewer runs; the pipeline goes
 *     straight to reconcile and re-sign (rebase, re-sign, task-file move, red-check rerun).
 *   - `delta`: the patch id changed. The reviewer set is chosen from the diff between the
 *     last attested head and the current head, not the whole PR.
 *   - `full`: no usable prior attestation; today's behaviour.
 *
 * @module next-step/resume-decision
 */

import { requiredReviewerKind } from '../../attestation-core/review-scope-core.mjs';
import { computePatchId } from '../attestation/patch-id.js';
import { resolveTargetBranch } from '../steps/02-compute-branch.js';
import { explicitReviewerSetMode } from '../steps/reviewer-set.js';
import type { ReviewerType } from '../types.js';
import type { NextStepContext } from './types.js';

export type ResumeReviewDecision =
  | { branch: 'unchanged'; note: 'review-skipped: unchanged'; lastHead: string }
  | {
      branch: 'delta';
      note: string;
      lastHead: string;
      reviewers: ReviewerType[];
      deltaPaths: string[];
    }
  | { branch: 'full'; note: 'review-full' };

const FULL: ResumeReviewDecision = { branch: 'full', note: 'review-full' };
const ENVELOPE_RE = /^(?:.*\/)?([0-9a-f]{40})(?:\.v\d+)?\.dsse\.json$/i;
const ATTESTATION_DIR = '.ai-sdlc/attestations/';

export interface ResumeDecisionOpts {
  /** Test injection: current patch id (default: computed against the target branch merge-base). */
  currentPatchId?: (base: string, head: string, cwd: string) => string | null;
  /** Test injection: true when the repository requires the three-reviewer set. */
  requireThree?: boolean;
}

/** Decide what a resumed task's review does. Never throws: any doubt returns `full`. */
export async function decideResumeReview(
  ctx: NextStepContext,
  worktreePath: string,
  opts: ResumeDecisionOpts = {},
): Promise<ResumeReviewDecision> {
  try {
    return await decide(ctx, worktreePath, opts);
  } catch {
    return FULL;
  }
}

async function decide(
  ctx: NextStepContext,
  cwd: string,
  opts: ResumeDecisionOpts,
): Promise<ResumeReviewDecision> {
  const git = async (args: string[]): Promise<string | null> => {
    const r = await ctx.runner('git', args, { cwd, allowFailure: true });
    return r.code === 0 ? r.stdout : null;
  };
  const target = `origin/${resolveTargetBranch(ctx.workDir)}`;
  const added = await git([
    'log',
    `${target}..HEAD`,
    '--diff-filter=A',
    '--name-only',
    '--format=',
    '--',
    ATTESTATION_DIR,
  ]);
  const file = added
    ?.split('\n')
    .map((l) => l.trim())
    .find((l) => ENVELOPE_RE.test(l));
  if (!file) return FULL;
  const attestedPatchId = ENVELOPE_RE.exec(file)![1].toLowerCase();
  const raw = await git(['show', `HEAD:${file}`]);
  if (raw === null) return FULL;
  const lastHead = (JSON.parse(raw) as { subject?: { digest?: { sha1?: string } } }).subject?.digest
    ?.sha1;
  if (typeof lastHead !== 'string' || !/^[0-9a-f]{40}$/i.test(lastHead)) return FULL;
  if ((await git(['cat-file', '-e', `${lastHead}^{commit}`])) === null) return FULL;

  const head = (await git(['rev-parse', 'HEAD']))?.trim() ?? '';
  const base = (await git(['merge-base', target, 'HEAD']))?.trim() ?? '';
  if (!base) return FULL;
  const current = (opts.currentPatchId ?? computePatchId)(base, head, cwd);
  if (current === null) return FULL;
  if (current.toLowerCase() === attestedPatchId) {
    return { branch: 'unchanged', note: 'review-skipped: unchanged', lastHead };
  }

  const names = await git([
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    `${lastHead}..HEAD`,
    '--',
    '.',
    `:(exclude)${ATTESTATION_DIR}`,
  ]);
  if (names === null) return FULL;
  const deltaPaths = names.split('\0').filter(Boolean);
  if (deltaPaths.length === 0) return FULL;
  const requireThree =
    opts.requireThree ??
    explicitReviewerSetMode({ workDir: ctx.workDir, baseRef: target }) === 'three';
  const kind = requiredReviewerKind(deltaPaths, { requireThree });
  const reviewers: ReviewerType[] =
    kind.kind === 'three'
      ? ['code-reviewer', 'test-reviewer', 'security-reviewer']
      : ['correctness-reviewer'];
  return {
    branch: 'delta',
    note: `review-delta: ${reviewers.join(', ')}`,
    lastHead,
    reviewers,
    deltaPaths,
  };
}
