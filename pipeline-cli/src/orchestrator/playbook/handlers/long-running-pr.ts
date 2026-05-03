/**
 * `LongRunningPRBlocksWorker` handler (RFC-0015 §5.1, row 8).
 *
 * Detection: a worker's PR has been open + queued for >2h without merge
 * OR rejection. Detection runs against `failure.prAgeMs` — populated by
 * the orchestrator's per-tick PR poll (Phase 1 already wired via Q10 =
 * Option A periodic poll).
 *
 * Remediation: park the worker — release the worktree, the PR continues
 * independently; orchestrator picks the next task. Per RFC §13 Q6
 * resolution: NO auto-rebase, NO escalation timer. Just release the slot
 * + emit `WorkerParked`.
 *
 * Budget: n/a (parking is a one-shot terminal action, not a retry loop).
 * The handler models budget=1 so it satisfies the same shape as the
 * other 8 modes; the runner's "attempts < budget" check fires once.
 */

import type { Handler, RemediationOutcome, WorkerContext, HandlerDeps } from '../types.js';

export const LONG_RUNNING_PR_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export const longRunningPrHandler: Handler = {
  mode: 'LongRunningPRBlocksWorker',
  budget: 1,
  detect(ctx: WorkerContext): boolean {
    const ageMs = ctx.failure.prAgeMs;
    if (ageMs === undefined || ageMs === null) return false;
    return ageMs >= LONG_RUNNING_PR_THRESHOLD_MS && !!ctx.prUrl;
  },
  async remediate(ctx: WorkerContext, deps: HandlerDeps): Promise<RemediationOutcome> {
    // Budget enforced by playbook-runner — handler is per-attempt only.
    deps.logger.warn(
      `[playbook/long-running-pr] parking worker ${ctx.workerId} (PR ${ctx.prUrl} aged ${Math.round(
        (ctx.failure.prAgeMs ?? 0) / 1000 / 60,
      )}min)`,
    );
    // No rebase, no escalation — per RFC §13 Q6 the orchestrator just
    // releases the slot. The events.jsonl entry is the operator's signal.
    return {
      status: 'recovered',
      nextState: 'PARKED',
      note: `parked after ${Math.round((ctx.failure.prAgeMs ?? 0) / 1000 / 60)}min open`,
    };
  },
  async escalate(ctx: WorkerContext, deps: HandlerDeps): Promise<void> {
    // Park does NOT label the PR (parking is not a defect — the PR is
    // legitimately mergeable; operator just decided not to wait). Log
    // the parking event for audit but skip the `needs-human-attention`
    // label the runner's generic escalator would apply.
    deps.logger.warn(
      `[playbook/long-running-pr] worker ${ctx.workerId} parked; PR ${ctx.prUrl} continues independently`,
    );
  },
};
