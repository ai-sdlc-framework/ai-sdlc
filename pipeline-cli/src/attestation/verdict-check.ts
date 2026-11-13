/**
 * RFC-0061: the verdict check. Fetches `refs/ai-sdlc/verdicts/<head>`, validates
 * the record, and returns one reason code. Coverage uses the shared rule from `review-coverage`;
 * the independence tier is read from the record (OQ-6), never recomputed.
 *
 * @module attestation/verdict-check
 */

import type { Runner } from '../runtime/exec.js';
import { computeRequiredReviewers, evaluateCoverage } from './review-coverage.js';
import {
  INDEPENDENCE_TIERS,
  LEAVES_FILE,
  RECORD_FILE,
  VerdictRecordSchema,
  recordMatchesLeaves,
  verdictRefName,
  type IndependenceTier,
  type VerdictRecord,
} from './verdict-record.js';

export type VerdictFailCode =
  | 'no-record'
  | 'subject-mismatch'
  | 'coverage-short'
  | 'replay-dirty'
  | 'tier-short'
  | 'not-clean-room';

export interface VerdictCheckResult {
  /** `ok`, `ok-carried:<sha>` or a failure code. */
  code: 'ok' | VerdictFailCode | `ok-carried:${string}`;
  ok: boolean;
  detail: string;
}

export interface VerdictCheckOpts {
  runner: Runner;
  cwd: string;
  remote?: string;
  headSha: string;
  /** Paths the PR touches; null fails closed to the three-reviewer set. */
  changedPaths: readonly string[] | null;
  requiredTier?: IndependenceTier;
  /**
   * AISDLC-1268: a fork head passes only with a record the gate's clean-room path wrote
   * (`issuedBy.principal: ci-clean-room`). Carry-forward is not consulted for such a head.
   */
  requireCleanRoom?: boolean;
  /** AISDLC-1170 carry-forward; called once when no record exists for the head. */
  carryForward?: (headSha: string) => Promise<{ from: string } | null>;
}

const fail = (code: VerdictFailCode, detail: string): VerdictCheckResult => ({
  code,
  ok: false,
  detail,
});

const tierRank = (t: IndependenceTier): number => INDEPENDENCE_TIERS.indexOf(t);

export async function checkVerdict(opts: VerdictCheckOpts): Promise<VerdictCheckResult> {
  const remote = opts.remote ?? 'origin';
  const git = (args: string[]) =>
    opts.runner('git', args, { cwd: opts.cwd, allowFailure: true, timeout: 120_000 });

  const noRecord = async (why: string): Promise<VerdictCheckResult> => {
    const carried =
      opts.carryForward && !opts.requireCleanRoom ? await opts.carryForward(opts.headSha) : null;
    if (carried) {
      return {
        code: `ok-carried:${carried.from}`,
        ok: true,
        detail: `carried from ${carried.from}`,
      };
    }
    return fail('no-record', why);
  };

  const fetched = await git(['fetch', '--no-tags', remote, verdictRefName(opts.headSha)]);
  if (fetched.code !== 0) return noRecord('no verdict ref for this head');
  const rec = await git(['show', `FETCH_HEAD:${RECORD_FILE}`]);
  const leaves = await git(['show', `FETCH_HEAD:${LEAVES_FILE}`]);
  if (rec.code !== 0 || leaves.code !== 0) return noRecord('verdict ref is missing its files');

  let parsed: VerdictRecord;
  try {
    parsed = VerdictRecordSchema.parse(JSON.parse(rec.stdout));
  } catch {
    return noRecord('record failed schema validation');
  }

  if (parsed.subject.headSha !== opts.headSha) {
    return fail('subject-mismatch', `record is for ${parsed.subject.headSha}`);
  }
  if (!recordMatchesLeaves(parsed, leaves.stdout)) {
    return fail('replay-dirty', 'leaves digest does not match the record');
  }

  if (opts.requireCleanRoom && parsed.issuedBy.principal !== 'ci-clean-room') {
    return fail(
      'not-clean-room',
      `fork head needs a clean-room record; this one was issued by ${parsed.issuedBy.principal}`,
    );
  }

  const required = computeRequiredReviewers({ changedPaths: opts.changedPaths });
  const approved = parsed.reviewers.filter((r) => r.verdict === 'approved').map((r) => r.name);
  const recorded = new Set(parsed.coverage.required);
  const missingFromRecord = required.required.filter((r) => !recorded.has(r));
  const cov = evaluateCoverage(required, approved);
  if (
    parsed.verdict !== 'approved' ||
    !parsed.coverage.satisfied ||
    missingFromRecord.length > 0 ||
    !cov.satisfied
  ) {
    return fail(
      'coverage-short',
      parsed.verdict !== 'approved'
        ? 'verdict is not approved'
        : `required reviewers not all approving: ${required.required.join(', ')}`,
    );
  }

  const need = opts.requiredTier ?? 'none';
  const lowest = parsed.reviewers.reduce<IndependenceTier>(
    (min, r) => (tierRank(r.independenceTier) < tierRank(min) ? r.independenceTier : min),
    'isolated',
  );
  if (tierRank(lowest) < tierRank(need)) {
    return fail('tier-short', `lowest reviewer tier ${lowest} is below required ${need}`);
  }
  return { code: 'ok', ok: true, detail: 'valid record' };
}
