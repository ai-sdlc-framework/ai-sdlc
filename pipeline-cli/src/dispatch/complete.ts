/**
 * Executor completion: turn the result of one `/ai-sdlc execute` run into a
 * verdict on the board.
 *
 * The verdict carries the pipeline outcome, the pull request number, the
 * follow-up task ids the executor filed and the decision ids it raised. The
 * verdict lands in `done/` (success, iterate-needed) or `failed/` (every other
 * outcome), through the same writer the other board commands use. The task
 * leaves `inflight/` for every outcome except iterate-needed, where the
 * manifest stays so the worker keeps the slot across the iteration.
 */

import { readInflightManifest, TASK_ID_RE, writeVerdict } from './board.js';
import { snapshotFailedManifest } from './requeue.js';
import type { DispatchVerdict, VerdictOutcome } from './types.js';
import { isValidCause, isValidDecisionId, MAX_DECISION_IDS, oneLine } from './verdict-fields.js';

const OUTCOMES: readonly VerdictOutcome[] = [
  'success',
  'iterate-needed',
  'iteration-exhausted',
  'failed',
  'quota-exhausted',
  'blocked',
];

/** What an executor reports when it finishes a task. */
export interface CompleteOptions {
  taskId: string;
  outcome: string;
  /** Pull request number, when the pipeline opened one. */
  prNumber?: number;
  prUrl?: string;
  /** Follow-up task ids filed while working the task. */
  followUpIds?: readonly string[];
  /** Decision ids raised while working the task. */
  decisionIds?: readonly string[];
  notes?: string;
  cause?: string;
  /** Executor name; must equal the name recorded at claim time. */
  workerId: string;
  now?: () => Date;
}

/** Result of a completion: where the verdict landed. */
export interface CompleteResult {
  verdictPath: string;
  state: 'done' | 'failed';
  verdict: DispatchVerdict;
}

/** Split a comma- or space-separated list flag into trimmed, non-empty items. */
export function splitIdList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Check that `worker` is the name the claim of `taskId` recorded, and return it.
 *
 * Shared by `complete` and `write-verdict` so both refuse the same way. This
 * guards against writing a verdict for the wrong task by mistake; it is not
 * authentication, because the recorded name is readable from the inflight
 * manifest and anyone who reads it can supply it. The recorded name is never
 * overwritten.
 * @throws when the task is not inflight, the claim recorded no worker (its
 *   holder cannot be verified), or `worker` differs from the recorded name.
 */
export function assertClaimHolder(boardDir: string, taskId: string, worker: string): string {
  const inflight = readInflightManifest(boardDir, taskId);
  if (!inflight) {
    throw new Error(`${taskId} is not inflight; there is nothing to complete`);
  }
  const recorded = inflight.workerId;
  if (!recorded) {
    throw new Error(`${taskId} has no recorded worker, so its claim holder cannot be verified`);
  }
  if (worker !== recorded) {
    throw new Error(
      `${taskId} is claimed by '${recorded}', not '${worker}'; the worker name must match the one recorded at claim time`,
    );
  }
  return recorded;
}

/**
 * Write the verdict for a task this executor holds.
 * @throws when the task id or outcome is invalid, a follow-up id is not a
 *   sub-id of the task, a decision id or the cause is malformed, the task is not inflight (nothing to complete), or the
 *   supplied worker name differs from the one recorded at claim time.
 */
export function completeTask(boardDir: string, opts: CompleteOptions): CompleteResult {
  if (!TASK_ID_RE.test(opts.taskId)) {
    throw new Error(`'${opts.taskId}' is not a valid task id`);
  }
  if (!OUTCOMES.includes(opts.outcome as VerdictOutcome)) {
    throw new Error(`outcome must be one of ${OUTCOMES.join(', ')} (got '${opts.outcome}')`);
  }
  if (opts.prNumber !== undefined && (!Number.isSafeInteger(opts.prNumber) || opts.prNumber < 1)) {
    throw new Error('the pull request number must be a positive integer');
  }
  const followUpIds = [...(opts.followUpIds ?? [])];
  for (const id of followUpIds) {
    if (!TASK_ID_RE.test(id) || !id.startsWith(`${opts.taskId}.`)) {
      throw new Error(`follow-up '${id}' is not a sub-id of ${opts.taskId}`);
    }
  }
  // Both reach the dispatch session's model and command lines, so they are
  // checked here, before anything is read or written.
  const decisionIds = [...(opts.decisionIds ?? [])];
  if (decisionIds.length > MAX_DECISION_IDS) {
    throw new Error(`a verdict may name at most ${MAX_DECISION_IDS} decisions`);
  }
  for (const id of decisionIds) {
    if (!isValidDecisionId(id)) {
      throw new Error(
        `'${oneLine(String(id), 40)}' is not a valid decision id (expected DEC-0000)`,
      );
    }
  }
  if (opts.cause !== undefined && !isValidCause(opts.cause)) {
    throw new Error(
      `'${oneLine(String(opts.cause), 40)}' is not a valid cause (lower-case words joined by hyphens, at most 64 characters)`,
    );
  }
  const inflight = readInflightManifest(boardDir, opts.taskId);
  if (!inflight) {
    throw new Error(`${opts.taskId} is not inflight; there is nothing to complete`);
  }
  // The supplied worker name must equal the name the claim recorded on the
  // manifest, and a manifest with no recorded name is refused. This guards
  // against completing the wrong task by mistake; it is not authentication,
  // because the recorded name is readable from the inflight manifest. The
  // recorded name is never overwritten.
  const workerId = inflight.workerId;
  if (!workerId) {
    throw new Error(
      `${opts.taskId} has no recorded worker, so its claim holder cannot be verified`,
    );
  }
  if (opts.workerId !== workerId) {
    throw new Error(
      `${opts.taskId} is claimed by '${workerId}', not '${opts.workerId}'; the worker name must match the one recorded at claim time`,
    );
  }
  const now = opts.now ?? (() => new Date());
  const verdict: DispatchVerdict = {
    schemaVersion: 'v1',
    taskId: opts.taskId,
    outcome: opts.outcome as VerdictOutcome,
    completedAt: now().toISOString(),
    workerId,
    workerKind: 'in-session-agent',
  };
  if (opts.prNumber !== undefined) verdict.prNumber = opts.prNumber;
  if (opts.prUrl) verdict.prUrl = opts.prUrl;
  if (followUpIds.length > 0) verdict.followUpIds = followUpIds;
  if (decisionIds.length > 0) verdict.decisionIds = decisionIds;
  if (opts.notes) verdict.notes = opts.notes;
  if (opts.cause) verdict.cause = opts.cause;
  const state = opts.outcome === 'success' || opts.outcome === 'iterate-needed' ? 'done' : 'failed';
  // The verdict removes the inflight manifest on a failure; keep a copy so the
  // task can be queued again by id.
  if (state === 'failed') snapshotFailedManifest(boardDir, inflight);
  const verdictPath = writeVerdict(boardDir, verdict);
  return { verdictPath, state, verdict };
}
