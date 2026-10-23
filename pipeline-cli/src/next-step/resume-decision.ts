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
 *   - `developer-round` (AISDLC-1053): `reenter --developer-round` set the manifest flag; the
 *     developer runs with the resume note, then the delta review takes the new patch id.
 *
 * @module next-step/resume-decision
 */

import { requiredReviewerKind } from '../../attestation-core/review-scope-core.mjs';
import { computePatchId } from '../attestation/patch-id.js';
import { loadVerifyCore } from '../attestation/verify-core-loader.js';
import { loadAttestationRuntime } from '../attestation/verify-runtime.js';
import { checkHeadEnvelope } from './head-envelope.js';
import { resolveTargetBranch } from '../steps/02-compute-branch.js';
import { explicitReviewerSetMode } from '../steps/reviewer-set.js';
import type { ReviewerType } from '../types.js';
import type { NextStepContext } from './types.js';

export type ResumeReviewDecision =
  | { branch: 'unchanged'; note: string; lastHead: string; resign?: true }
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
const ENVELOPE_RE = /^(?:.*\/)?([0-9a-f]{40})(?:\.v\d+)?\.dsse\.json$/i;
const ATTESTATION_DIR = '.ai-sdlc/attestations/';

/** The slice of the context the decision reads (AISDLC-1053: callers outside next-step pass just these). */
export type ResumeDecisionCtx = Pick<NextStepContext, 'workDir' | 'runner'>;

export interface ResumeDecisionOpts {
  /** `resume.developerRound` of the inflight manifest: force the developer branch (AISDLC-1053). */
  developerRound?: boolean;
  /** Test injection: current patch id (default: computed against the target branch merge-base). */
  currentPatchId?: (base: string, head: string, cwd: string) => string | null;
  /** Test injection: true when the repository requires the three-reviewer set. */
  requireThree?: boolean;
  /**
   * Test injection: verify the signed attestation for `headSha` (signature against the trusted
   * reviewers, Merkle proof, patch-id binding, review scope). Default: the trusted verifier core.
   */
  verifyAt?: (
    headSha: string,
    baseSha: string,
    cwd: string,
    trustedReviewersYaml: string,
  ) => Promise<boolean>;
}

/**
 * Run the same verifier CI runs (`cli-attestation verify`) against `headSha`. The runtime is
 * resolved from OUTSIDE the checkout, so a forged envelope committed on the branch cannot
 * vouch for itself. Any failure (including an unresolvable runtime) is "not verified".
 */
async function verifyAttestationAt(
  headSha: string,
  baseSha: string,
  cwd: string,
  trustedReviewersYaml: string,
): Promise<boolean> {
  try {
    const core = await loadVerifyCore();
    core.bindRuntime(await loadAttestationRuntime(cwd));
    return (
      core.runVerifier({ headSha, baseSha, repoRoot: cwd, trustedReviewersYaml }).status === 'valid'
    );
  } catch {
    return false;
  }
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
  // SECURITY: the signer allowlist comes from the target branch, never the worktree copy a PR
  // could edit to trust its own forged key.
  const trustedYaml = await git(['show', `${target}:.ai-sdlc/trusted-reviewers.yaml`]);
  if (trustedYaml === null) return FULL;
  const verify = (h: string, b: string, c: string): Promise<boolean> =>
    (opts.verifyAt ?? verifyAttestationAt)(h, b, c, trustedYaml);
  if (current.toLowerCase() === attestedPatchId) {
    if (!(await verify(head, base, cwd))) return FULL;
    // AISDLC-984: the same predicate ship uses; a head without its v6 envelope goes to re-sign.
    const env = await checkHeadEnvelope(ctx, cwd, { patchId: () => current });
    if (env.status === 'missing') {
      return {
        branch: 'unchanged',
        note: `review-skipped: unchanged; re-sign required: ${env.reason}`,
        lastHead,
        resign: true,
      };
    }
    return { branch: 'unchanged', note: 'review-skipped: unchanged', lastHead };
  }

  // The delta base (`lastHead`) comes from the envelope, so the envelope must verify first.
  if (!(await verify(lastHead, base, cwd))) return FULL;
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
