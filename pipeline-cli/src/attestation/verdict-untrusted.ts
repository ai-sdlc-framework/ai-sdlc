/**
 * RFC-0061 OQ-7: the verdict record for untrusted PRs. The clean-room job turns the validated
 * UCVG report into a record (`issuedBy.principal: ci-clean-room`, tier `isolated`) and uploads it
 * as an Actions artifact. A trusted `workflow_run` writer then validates the artifact against the
 * triggering run and writes the verdict ref for the head. No PR content is read by the writer.
 *
 * @module attestation/verdict-untrusted
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UntrustedPrReport } from '../pipeline/report-validator.js';
import { computeRequiredReviewers, evaluateCoverage } from './review-coverage.js';
import {
  LEAVES_FILE,
  RECORD_FILE,
  VerdictRecordSchema,
  finalizeVerdictRecord,
  recordMatchesLeaves,
  type VerdictRecord,
} from './verdict-record.js';

/** The UCVG report's three reviewers mapped to the policy's reviewer names. */
const REVIEWER_NAMES = {
  code: 'code-reviewer',
  test: 'test-reviewer',
  security: 'security-reviewer',
} as const;

type ReviewerKey = keyof typeof REVIEWER_NAMES;
const KEYS = Object.keys(REVIEWER_NAMES) as ReviewerKey[];

export interface CleanRoomVerdictOpts {
  treeSha: string;
  repository: string;
  now?: Date;
}

/** Build the record and leaves from a Zod-validated UCVG report. */
export function buildCleanRoomVerdict(
  report: UntrustedPrReport,
  opts: CleanRoomVerdictOpts,
): { record: VerdictRecord; leavesJsonl: string } {
  const reviewers = KEYS.map((k) => ({
    name: REVIEWER_NAMES[k],
    harness: 'ucvg-sandbox',
    model: '',
    independenceTier: 'isolated' as const,
    verdict: report.reviewers[k].approved ? ('approved' as const) : ('changes_requested' as const),
  }));
  const approved = reviewers.filter((r) => r.verdict === 'approved').map((r) => r.name);
  // changedPaths null fails closed to the three-reviewer set, which the UCVG matrix always runs.
  const coverage = evaluateCoverage(computeRequiredReviewers({ changedPaths: null }), approved);
  const verdict =
    report.consensus.approved && coverage.satisfied ? 'approved' : 'changes_requested';
  return finalizeVerdictRecord(
    {
      verdict,
      reviewers,
      coverage,
      leaves: KEYS.map((k) => ({
        reviewer: REVIEWER_NAMES[k],
        approved: report.reviewers[k].approved,
        findings: report.reviewers[k].findings.length,
        promptInjectionDetected: report.reviewers[k].promptInjectionDetected,
      })),
    },
    {
      subject: {
        headSha: report.headSha.toLowerCase(),
        treeSha: opts.treeSha,
        baseSha: report.baseSha.toLowerCase(),
        repository: opts.repository,
        pullRequest: report.prNumber,
      },
      principal: 'ci-clean-room',
      now: opts.now,
    },
  );
}

/** Write `record.json` and `leaves.jsonl` into `dir` (the artifact payload). */
export function writeVerdictArtifact(
  dir: string,
  record: VerdictRecord,
  leavesJsonl: string,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, RECORD_FILE), JSON.stringify(record, null, 2) + '\n');
  writeFileSync(join(dir, LEAVES_FILE), leavesJsonl);
}

export interface WorkflowJob {
  name: string;
  conclusion: string | null;
}

/** Job-name prefixes of the triggering UCVG run that must have concluded `success`. */
export const REQUIRED_REVIEW_JOB_PREFIXES = ['Stage 2/3:', 'Stage 4:'] as const;

/** Null when every review job succeeded, else the reason. */
export function reviewJobsSucceeded(jobs: readonly WorkflowJob[]): string | null {
  for (const prefix of REQUIRED_REVIEW_JOB_PREFIXES) {
    const job = jobs.find((j) => j.name.startsWith(prefix));
    if (!job) return `review job "${prefix}" not found in the triggering run`;
    if (job.conclusion !== 'success') {
      return `review job "${prefix}" concluded ${job.conclusion ?? 'none'}, not success`;
    }
  }
  return null;
}

export interface ArtifactCheckInput {
  dir: string;
  /** `workflow_run.head_sha`: the PR head of the triggering run. */
  headSha: string;
  repository: string;
  /** Jobs of the triggering run, from the Actions API. */
  jobs: readonly WorkflowJob[];
  /** Tree sha of `headSha` according to the GitHub API, when the caller resolved it. */
  expectedTreeSha?: string;
}

export type ArtifactCheck =
  { ok: true; record: VerdictRecord; leavesJsonl: string } | { ok: false; reason: string };

/** Validate a downloaded artifact. Treats every byte of it as untrusted data. */
export function validateVerdictArtifact(input: ArtifactCheckInput): ArtifactCheck {
  const bad = (reason: string): ArtifactCheck => ({ ok: false, reason });
  const jobsReason = reviewJobsSucceeded(input.jobs);
  if (jobsReason) return bad(jobsReason);
  const recPath = join(input.dir, RECORD_FILE);
  const leavesPath = join(input.dir, LEAVES_FILE);
  if (!existsSync(recPath) || !existsSync(leavesPath)) return bad('artifact is missing its files');
  let record: VerdictRecord;
  try {
    record = VerdictRecordSchema.parse(JSON.parse(readFileSync(recPath, 'utf8')));
  } catch {
    return bad('record failed schema validation');
  }
  const leavesJsonl = readFileSync(leavesPath, 'utf8');
  if (record.subject.headSha !== input.headSha) {
    return bad(`record head ${record.subject.headSha} does not match the PR head ${input.headSha}`);
  }
  if (record.subject.repository !== input.repository) {
    return bad(`record repository ${record.subject.repository} is not ${input.repository}`);
  }
  if (input.expectedTreeSha && record.subject.treeSha !== input.expectedTreeSha) {
    return bad('record tree does not match the PR head tree');
  }
  if (record.issuedBy.principal !== 'ci-clean-room') {
    return bad(`unexpected issuer ${record.issuedBy.principal}`);
  }
  if (record.reviewers.some((r) => r.independenceTier !== 'isolated')) {
    return bad('clean-room records must carry tier isolated');
  }
  if (!recordMatchesLeaves(record, leavesJsonl)) return bad('leaves digest does not match');
  return { ok: true, record, leavesJsonl };
}
