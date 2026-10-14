/**
 * Deterministic classifier for the dispatch tick's PR and board state machine
 * (AISDLC-823). The tick gathers REST facts per open task PR, this module maps
 * each to exactly one state and the one action the table names. A PR that fits
 * no row classifies as `no-match`: the only state routed to the planner.
 */

import { writeEvent } from '../orchestrator/events.js';

/** Heartbeat age after which an inflight claim is stale. */
export const STALE_CLAIM_MS = 30 * 60 * 1000;

/** Outcome of one check run or status, normalised by the caller from REST. */
export type CheckConclusion = 'success' | 'failure' | 'cancelled' | 'infra' | 'pending';

export interface PrCheck {
  name: string;
  conclusion: CheckConclusion;
  /** Failure summary line; for attestation, the text naming the mismatch. */
  summary?: string;
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
  /** Age of the inflight claim's last heartbeat, when the task holds a claim. */
  claimHeartbeatAgeMs?: number;
  headBranch?: string;
  manifestBranch?: string;
}

export const PR_STATES = [
  'merged',
  'manifest-branch-mismatch',
  'stale-claim',
  'behind-or-dirty',
  'attestation-content-hash-mismatch',
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
  'stale-claim': 'reap-then-write-resume-signal',
  'behind-or-dirty': 'requeue-hand-review-path-resume',
  'attestation-content-hash-mismatch': 'push-only-resign-resume',
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
  if (f.claimHeartbeatAgeMs !== undefined && f.claimHeartbeatAgeMs > STALE_CLAIM_MS) {
    return mk('stale-claim');
  }
  if (f.mergeStateStatus === 'BEHIND' || f.mergeStateStatus === 'DIRTY') {
    return mk('behind-or-dirty');
  }
  const att = checks.find((c) => c.name === ATTESTATION && failed(c));
  if (att && /content[- ]?hash/i.test(att.summary ?? '')) {
    return mk('attestation-content-hash-mismatch');
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
