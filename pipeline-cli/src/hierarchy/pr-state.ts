/**
 * Deterministic classifier for the dispatch tick's PR and board state machine
 * (AISDLC-823; a stale claim is owned by `stall.ts`, AISDLC-826). The tick gathers REST facts per open task PR, this module maps
 * each to exactly one state and the one action the table names. A PR that fits
 * no row classifies as `no-match`: the only state routed to the planner.
 */

import { writeEvent } from '../orchestrator/events.js';

/** Outcome of one check run or status, normalised by the caller from REST. */
export type CheckConclusion = 'success' | 'failure' | 'cancelled' | 'infra' | 'pending';

export interface PrCheck {
  name: string;
  conclusion: CheckConclusion;
  /** Failure summary line; for attestation, the text naming the mismatch. */
  summary?: string;
  /** Link to the check run; names the workflow run whose log holds the failing line. */
  detailsUrl?: string;
  /** Job duration in seconds (completedAt - startedAt), when known. */
  durationSec?: number;
  /** The job was skipped (the rollup reports it as success; this keeps the fact). */
  skipped?: boolean;
}

/** REST facts for one open (or just merged) task PR. */
export interface PrFacts {
  prNumber: number;
  taskId: string;
  merged?: boolean;
  draft?: boolean;
  /** GitHub `mergeStateStatus`: CLEAN, BEHIND, DIRTY, BLOCKED, ... */
  mergeStateStatus?: string;
  autoMergeArmed?: boolean;
  /** An approved review verdict exists for the head. */
  approvedVerdict?: boolean;
  checks?: PrCheck[];
  headBranch?: string;
  manifestBranch?: string;
}

export const PR_STATES = [
  'merged',
  'manifest-branch-mismatch',
  'behind-or-dirty',
  'attestation-content-hash-mismatch',
  'rate-limited',
  'real-failure',
  'cancelled-or-infra',
  'ready-to-flip',
  'armed-clean',
  'pending',
  'no-match',
] as const;

export type PrState = (typeof PR_STATES)[number];

export const PR_ACTIONS: Record<PrState, string> = {
  merged: 'mark-done-sync-parent-start-next',
  'manifest-branch-mismatch': 'write-manifest-with-pr-head-ref-and-requeue',
  'behind-or-dirty': 'requeue-hand-review-path-resume',
  'attestation-content-hash-mismatch': 'push-only-resign-resume',
  'rate-limited': 'wait-and-rerun',
  'real-failure': 'full-fix-resume-with-failing-line',
  'cancelled-or-infra': 'rerun-workflow',
  'ready-to-flip': 'flip-ready-via-rest',
  'armed-clean': 'none',
  pending: 'none',
  'no-match': 'route-to-planner',
};

export interface PrClassification {
  prNumber: number;
  taskId: string;
  state: PrState;
  action: string;
  /** Failing line for `real-failure`, for the resume note. */
  failingLine?: string;
}

const ATTESTATION = 'ai-sdlc/attestation';
const PR_READY = 'ai-sdlc/pr-ready';

/** Checks that fail on every PR when the App installation rate limit is exhausted. */
export const RATE_LIMIT_CHECKS: readonly string[] = [
  'Detect Changes',
  'ai-sdlc/issue-link',
  PR_READY,
];
const RATE_LIMIT_RE = /rate limit exceeded for installation/i;
/** A job that dies on the rate limit finishes in seconds; a real failure runs longer. */
export const RATE_LIMIT_MAX_JOB_SEC = 30;

/**
 * AISDLC-949 signature: every failing job (the pr-ready rollup aside) finished
 * under 30 s and its annotation or log carries the installation rate-limit text.
 */
function rateLimitSignature(failedChecks: readonly PrCheck[]): boolean {
  const jobs = failedChecks.filter((c) => c.name !== PR_READY);
  return (
    jobs.length > 0 &&
    jobs.every(
      (c) =>
        c.durationSec !== undefined &&
        c.durationSec < RATE_LIMIT_MAX_JOB_SEC &&
        RATE_LIMIT_RE.test(c.summary ?? ''),
    )
  );
}

/**
 * AISDLC-953 structural shape: the only failed gate jobs are `Detect Changes`
 * (and optionally `ai-sdlc/issue-link`, plus the `pr-ready` rollup) and every
 * other check was skipped. No test ran, so nothing the code can fix was seen.
 */
function detectChangesOnlyShape(checks: readonly PrCheck[]): boolean {
  const failedJobs = checks.filter((c) => c.conclusion === 'failure' && c.name !== PR_READY);
  if (!failedJobs.some((c) => c.name === 'Detect Changes')) return false;
  if (!failedJobs.every((c) => c.name === 'Detect Changes' || c.name === 'ai-sdlc/issue-link')) {
    return false;
  }
  const others = checks.filter((c) => c.conclusion !== 'failure');
  return others.every((c) => c.skipped === true || c.name === PR_READY);
}

function failed(c: PrCheck): boolean {
  return c.conclusion === 'failure';
}

/** Classify one PR into exactly one state. Pure and deterministic. */
export function classifyPr(f: PrFacts): PrClassification {
  const checks = f.checks ?? [];
  const mk = (state: PrState, failingLine?: string): PrClassification => ({
    prNumber: f.prNumber,
    taskId: f.taskId,
    state,
    action: PR_ACTIONS[state],
    ...(failingLine === undefined ? {} : { failingLine }),
  });

  if (f.merged) return mk('merged');
  if (f.manifestBranch && f.headBranch && f.manifestBranch !== f.headBranch) {
    return mk('manifest-branch-mismatch');
  }
  if (f.mergeStateStatus === 'BEHIND' || f.mergeStateStatus === 'DIRTY') {
    return mk('behind-or-dirty');
  }
  const att = checks.find((c) => c.name === ATTESTATION && failed(c));
  if (att && /content[- ]?hash/i.test(att.summary ?? '')) {
    return mk('attestation-content-hash-mismatch');
  }
  const failedChecks = checks.filter(failed);
  if (
    rateLimitSignature(failedChecks) ||
    detectChangesOnlyShape(checks) ||
    (failedChecks.length > 0 &&
      failedChecks.every((c) => RATE_LIMIT_CHECKS.includes(c.name)) &&
      failedChecks.some((c) => RATE_LIMIT_RE.test(c.summary ?? '')))
  ) {
    return mk('rate-limited');
  }
  const ready = checks.find((c) => c.name === PR_READY && failed(c));
  if (ready) return mk('real-failure', ready.summary);
  if (checks.some((c) => c.conclusion === 'cancelled' || c.conclusion === 'infra')) {
    return mk('cancelled-or-infra');
  }
  const green = checks.length > 0 && checks.every((c) => c.conclusion === 'success');
  if (green && f.draft && f.approvedVerdict) return mk('ready-to-flip');
  if (green && !f.draft && f.mergeStateStatus === 'CLEAN' && f.autoMergeArmed) {
    return mk('armed-clean');
  }
  if (
    checks.length === 0 ||
    (checks.some((c) => c.conclusion === 'pending') && !checks.some(failed))
  ) {
    return mk('pending');
  }
  return mk('no-match');
}

/** Event type written once per classification. */
export const PR_CLASSIFIED_EVENT = 'DispatchPrClassified';

/** Classify every PR and write one event per classification. Returns the classifications. */
export function classifyAndRecord(
  facts: readonly PrFacts[],
  opts: { artifactsDir?: string; write?: typeof writeEvent } = {},
): PrClassification[] {
  const write = opts.write ?? writeEvent;
  return facts.map((f) => {
    const c = classifyPr(f);
    write(
      {
        ts: '',
        type: PR_CLASSIFIED_EVENT,
        taskId: c.taskId,
        prNumber: c.prNumber,
        state: c.state,
        action: c.action,
      },
      opts.artifactsDir === undefined ? {} : { artifactsDir: opts.artifactsDir },
    );
    return c;
  });
}
