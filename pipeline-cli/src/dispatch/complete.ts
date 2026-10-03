/**
 * Executor completion: turn the result of one `/ai-sdlc execute` run into a
 * verdict on the board.
 *
 * The verdict carries the pipeline outcome, the pull request number, the
 * follow-up task ids the executor filed and the decision ids it raised. Landing
 * it moves the task out of `inflight/` into `done/` (success) or `failed/`
 * (every other outcome), through the same writer the other board commands use.
 */

import { readInflightManifest, TASK_ID_RE, writeVerdict } from './board.js';
import type { DispatchVerdict, VerdictOutcome } from './types.js';

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
 * Write the verdict for a task this executor holds.
 * @throws when the task id or outcome is invalid, a follow-up id is not a
 *   sub-id of the task, the task is not inflight (nothing to complete), or the
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
  const decisionIds = [...(opts.decisionIds ?? [])];
  if (decisionIds.length > 0) verdict.decisionIds = decisionIds;
  if (opts.notes) verdict.notes = opts.notes;
  if (opts.cause) verdict.cause = opts.cause;
  const verdictPath = writeVerdict(boardDir, verdict);
  const state = opts.outcome === 'success' || opts.outcome === 'iterate-needed' ? 'done' : 'failed';
  return { verdictPath, state, verdict };
}
