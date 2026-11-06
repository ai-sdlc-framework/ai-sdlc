/**
 * Resume review decision (AISDLC-947, RFC-0061 Phase 2).
 *
 * One decision at the top of a resume, from the review verdict ref outside the branch. No
 * patch-id comparison and no envelope read remain here.
 *
 *   - `unchanged`: the head has a verdict record, or an earlier approved record carries forward
 *     by the clean-replay rule (AISDLC-1170). No developer and no reviewer runs; the pipeline
 *     goes straight to reconcile and push.
 *   - `delta`: no record for the head, but an earlier approved head is reachable. The reviewer
 *     set is chosen from the diff between that head and the current head, not the whole PR.
 *   - `full`: no usable earlier record; today's behaviour ("carried forward, else review").
 *   - `developer-round` (AISDLC-1053): `reenter --developer-round` set the manifest flag; the
 *     developer runs with the resume note, then the delta review takes the new head.
 *
 * @module next-step/resume-decision
 */

import { requiredReviewerKind } from '../../attestation-core/review-scope-core.mjs';
import { listEarlierSubjects } from '../attestation/verdict-cli.js';
import { checkHeadVerdict, type HeadVerdictStatus } from './head-envelope.js';
import { resolveTargetBranch } from '../steps/02-compute-branch.js';
import { explicitReviewerSetMode } from '../steps/reviewer-set.js';
import type { ReviewerType } from '../types.js';
import type { NextStepContext } from './types.js';

export type ResumeReviewDecision =
  | { branch: 'unchanged'; note: string; lastHead: string }
  | {
      branch: 'delta';
      note: string;
      lastHead: string;
      reviewers: ReviewerType[];
      deltaPaths: string[];
    }
  | { branch: 'full'; note: 'review-full' }
  /** AISDLC-1053: the reenter ordered a developer round; the unchanged shortcut is bypassed. */
  | { branch: 'developer-round'; note: string };

const FULL: ResumeReviewDecision = { branch: 'full', note: 'review-full' };

/** The slice of the context the decision reads (AISDLC-1053: callers outside next-step pass just these). */
export type ResumeDecisionCtx = Pick<NextStepContext, 'workDir' | 'runner'>;

export interface ResumeDecisionOpts {
  /** `resume.developerRound` of the inflight manifest: force the developer branch (AISDLC-1053). */
  developerRound?: boolean;
  /** Test injection: true when the repository requires the three-reviewer set. */
  requireThree?: boolean;
  /** Test injection: the head's verdict status (default: remote ref, else clean-replay carry). */
  headVerdict?: (ctx: ResumeDecisionCtx, cwd: string) => Promise<HeadVerdictStatus>;
  /** Test injection: earlier approved heads, newest first (default: the remote verdict refs). */
  earlierHeads?: (
    ctx: ResumeDecisionCtx,
    cwd: string,
    head: string,
    pullRequest: number,
  ) => Promise<string[]>;
  /** Test injection: the PR number of the branch (default: `gh pr view`); null means none. */
  pullRequest?: number | null;
}

/** The open PR number of the worktree's branch, or null when there is none (AISDLC-1220). */
async function resolvePullRequest(ctx: ResumeDecisionCtx, cwd: string): Promise<number | null> {
  const r = await ctx.runner('gh', ['pr', 'view', '--json', 'number', '--jq', '.number'], {
    cwd,
    allowFailure: true,
  });
  if (r.code !== 0) return null;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Decide what a resumed task's review does. Never throws: any doubt returns `full`. */
export async function decideResumeReview(
  ctx: ResumeDecisionCtx,
  worktreePath: string,
  opts: ResumeDecisionOpts = {},
): Promise<ResumeReviewDecision> {
  if (opts.developerRound) {
    return { branch: 'developer-round', note: 'developer-round: ordered by reenter' };
  }
  try {
    return await decide(ctx, worktreePath, opts);
  } catch {
    return FULL;
  }
}

async function decide(
  ctx: ResumeDecisionCtx,
  cwd: string,
  opts: ResumeDecisionOpts,
): Promise<ResumeReviewDecision> {
  const git = async (args: string[]): Promise<string | null> => {
    const r = await ctx.runner('git', args, { cwd, allowFailure: true });
    return r.code === 0 ? r.stdout : null;
  };
  const target = `origin/${resolveTargetBranch(ctx.workDir)}`;
  const verdict = await (opts.headVerdict ?? checkHeadVerdict)(ctx, cwd);
  if (verdict.status === 'present') {
    return {
      branch: 'unchanged',
      note: 'review-skipped: verdict record present',
      lastHead: verdict.headSha,
    };
  }
  if (verdict.status === 'carried') {
    return {
      branch: 'unchanged',
      note: `review-skipped: verdict carried forward from ${verdict.from}`,
      lastHead: verdict.from,
    };
  }

  const head = verdict.headSha || ((await git(['rev-parse', 'HEAD']))?.trim() ?? '');
  // AISDLC-1220: the baseline is chosen among earlier approved heads of THIS PR only; no PR, no delta.
  const pullRequest =
    opts.pullRequest !== undefined ? opts.pullRequest : await resolvePullRequest(ctx, cwd);
  if (pullRequest === null) return FULL;
  const earlierHeads =
    opts.earlierHeads ??
    (async (c, d, h, pr) => (await listEarlierSubjects(c.runner, d, h, pr)).map((x) => x.headSha));
  let lastHead: string | null = null;
  for (const candidate of await earlierHeads(ctx, cwd, head, pullRequest)) {
    // Records carry pullRequest 0 (the writer does not know the PR), so a baseline must also be
    // an ancestor of this head: a record from another PR's branch is never in this lineage.
    if (
      (await git(['cat-file', '-e', `${candidate}^{commit}`])) !== null &&
      (await git(['merge-base', '--is-ancestor', candidate, head])) !== null
    ) {
      lastHead = candidate;
      break;
    }
  }
  if (!lastHead) return FULL;
  const names = await git([
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    `${lastHead}..HEAD`,
    '--',
    '.',
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
      : // The merge gate covers the whole PR and needs correctness plus security (AISDLC-1220).
        ['correctness-reviewer', 'security-reviewer'];
  return {
    branch: 'delta',
    note: `review-delta: ${reviewers.join(', ')}`,
    lastHead,
    reviewers,
    deltaPaths,
  };
}
