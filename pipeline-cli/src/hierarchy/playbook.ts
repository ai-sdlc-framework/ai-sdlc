/**
 * The unblocking playbook the dispatch session applies to a failed task.
 *
 * Each failure is classified from its `failed/` record and handled by exactly
 * one step, each gated by the operational authority list and recorded as an
 * `OperatorPlaybookAction` event:
 *
 *  - a mechanical conflict shape: rebase the task branch onto `origin/main` and
 *    lease-push to that branch only;
 *  - CI stuck on a stale merge ref: an empty commit pushed to the task branch;
 *  - a transient failure still within the retry limit: re-queue by id;
 *  - anything else, or a step that is not permitted or does not work: escalate
 *    (the outcome carries the message for the planner) and take no git action.
 *
 * Every git invocation goes through one guarded runner. A push is allowed in
 * exactly one shape: `push [--force-with-lease] origin HEAD:refs/heads/<branch>`,
 * where `<branch>` is the task's own branch (`ai-sdlc/<task-id>` with an optional
 * `-<slug>` suffix). `main`, `master` and every other ref are unreachable, in any
 * refspec spelling.
 *
 * A lease push also needs the trusted policy's `allowForcePush: leaseOnOwnBranch`,
 * a branch that is not on the policy's protected list, and a worktree that
 * verifies as a genuine one of this repository (checked before git runs in it).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { TASK_ID_RE } from '../dispatch/board.js';
import type { DispatchVerdict } from '../dispatch/types.js';
import {
  INVALID_TASK_ID,
  isValidCause,
  isValidDecisionId,
  oneLine,
} from '../dispatch/verdict-fields.js';
import { isRebaseFixable, type FailureShape } from '../runtime/ci-failure-watcher.js';
import type { EventEmitter } from './emit.js';
import { isProtectedBranch, type ForcePushMode } from './lease-policy.js';
import type { OperationalAction } from './operational.js';
import type { AsyncCommandRunner, CommandResult, CommandRunner } from './types.js';

/** Steps the playbook can take or refuse. */
export type PlaybookAction = 'rebase-push' | 'retrigger-ci' | 'requeue' | 'escalate';

/** Cause code written on a failure record when CI is stuck on a stale merge ref. */
export const STALE_MERGE_REF_CAUSE = 'stale-merge-ref';

/** Conflict shapes a plain rebase onto `origin/main` is expected to fix. */
export const MECHANICAL_SHAPES: readonly FailureShape[] = [
  'test-additions-overlap',
  'prettier-drift',
  'pnpm-lock-regen',
  'package-json-bin-concat',
  'behind-only',
];

/** Cause codes of failures that can simply be run again. */
export const REQUEUEABLE_CAUSES: readonly string[] = [
  'stale-heartbeat',
  'spawn-rejected',
  'quota-exhausted',
  'transient',
];

type StepAction = Exclude<PlaybookAction, 'escalate'>;

/** Operational grants each step needs. */
export const REQUIRED_GRANTS: Record<StepAction, readonly OperationalAction[]> = {
  'rebase-push': ['rebase-own-branch', 'lease-push-own-branch'],
  'retrigger-ci': ['retrigger-ci'],
  requeue: ['requeue'],
};

/** The step chosen for a failure. */
export type Classification =
  | { kind: 'rebase-push'; shape: string }
  | { kind: 'retrigger-ci' }
  | { kind: 'requeue'; cause: string }
  | { kind: 'escalate'; reason: string };

/** Choose the step for a failure record. Pure; touches nothing. */
export function classifyFailure(verdict: DispatchVerdict): Classification {
  const cause = verdict.cause;
  if (!cause) {
    return {
      kind: 'escalate',
      reason: `the failure record names no cause (${oneLine(String(verdict.outcome), 40)})`,
    };
  }
  if (!isValidCause(cause)) {
    return { kind: 'escalate', reason: 'the failure record has a malformed cause code' };
  }
  if (
    (MECHANICAL_SHAPES as readonly string[]).includes(cause) &&
    isRebaseFixable(cause as FailureShape)
  ) {
    return { kind: 'rebase-push', shape: cause };
  }
  if (cause === STALE_MERGE_REF_CAUSE) return { kind: 'retrigger-ci' };
  if (REQUEUEABLE_CAUSES.includes(cause)) return { kind: 'requeue', cause };
  return { kind: 'escalate', reason: `unrecognised failure shape '${oneLine(cause, 80)}'` };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `name` is a branch that belongs to `taskId`: `ai-sdlc/<id>` plus an optional slug. */
export function isOwnTaskBranch(name: string, taskId: string): boolean {
  if (typeof name !== 'string' || name.includes('..')) return false;
  const re = new RegExp(`^ai-sdlc/${escapeRegExp(taskId.toLowerCase())}(-[a-z0-9][a-z0-9._-]*)?$`);
  return re.test(name);
}

/**
 * True only for `push [--force-with-lease] origin HEAD:refs/heads/<own task branch>`.
 * Anything else, including a bare branch name, a `+` or `:` refspec, a forced or
 * deleting push, or a protected branch, is false.
 */
export function isSafeTaskPush(args: readonly string[], taskId: string): boolean {
  if (args[0] !== 'push') return false;
  let rest = args.slice(1);
  if (rest[0] === '--force-with-lease') rest = rest.slice(1);
  if (rest.length !== 2 || rest[0] !== 'origin') return false;
  const m = /^HEAD:refs\/heads\/(.+)$/.exec(rest[1]!);
  return m !== null && isOwnTaskBranch(m[1]!, taskId);
}

const GIT_SUBCOMMANDS = new Set(['branch', 'fetch', 'status', 'rebase', 'commit', 'push']);

/** Collaborators of {@link runPlaybook}; every one is injected in tests. */
export interface PlaybookDeps {
  /** Runs git. Never given a shell. Either kind of runner is accepted and awaited. */
  run: CommandRunner | AsyncCommandRunner;
  /** Repository root; task worktrees live under `.worktrees/`. */
  repoRoot: string;
  /** Actions the policy grants the dispatch role. */
  operational: ReadonlySet<string>;
  /** The trusted policy's `allowForcePush`; a lease push is refused unless `leaseOnOwnBranch`. */
  forcePushMode: ForcePushMode;
  /** The trusted policy's extra protected branch names (patterns may end in `*`). */
  protectedBranches: readonly string[];
  /**
   * Checks, without running git, that a worktree is a genuine one of this
   * repository. Returns null when it is, otherwise the reason it is not.
   */
  ownWorktree: (worktree: string) => string | null;
  /** Re-queues a failed task by id; throws when it must not be. */
  requeue: (taskId: string) => { retryCount: number };
  emit: EventEmitter;
  /** Roster name of the dispatch session, recorded on every event. */
  workerId: string;
  exists?: (file: string) => boolean;
}

/** What the playbook did with one failure. */
export interface PlaybookOutcome {
  taskId: string;
  /** The step that ended the run; `escalate` when nothing else could be done. */
  action: PlaybookAction;
  result: 'done' | 'refused' | 'failed' | 'escalated';
  reason: string;
  branch?: string;
  /** Present when the failure goes to the planner. */
  escalation?: { taskId: string; message: string };
}

/**
 * Apply the playbook to one failure.
 *
 * Never throws for a failing step: a step that is refused or fails is recorded
 * and turned into an escalation.
 */
export async function runPlaybook(
  verdict: DispatchVerdict,
  deps: PlaybookDeps,
): Promise<PlaybookOutcome> {
  const taskId = verdict.taskId;
  // The id comes from a file on the board; it builds a worktree path and a branch
  // pattern below, so nothing runs for an id that is not a well-formed task id.
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
    const reason = 'the failure record has an invalid task id';
    return {
      taskId: INVALID_TASK_ID,
      action: 'escalate',
      result: 'escalated',
      reason,
      escalation: {
        taskId: INVALID_TASK_ID,
        message: `A failure record cannot be handled: ${reason}`,
      },
    };
  }

  const record = (
    action: PlaybookAction,
    result: PlaybookOutcome['result'],
    reason: string,
    branch?: string,
  ): void => {
    deps.emit({
      type: 'OperatorPlaybookAction',
      taskId,
      action,
      result,
      reason,
      workerId: deps.workerId,
      ...(branch ? { branch } : {}),
    });
  };

  const escalate = (reason: string, branch?: string): PlaybookOutcome => {
    record('escalate', 'escalated', reason, branch);
    const detail = oneLine(verdict.notes, 300);
    const label = !verdict.cause
      ? oneLine(String(verdict.outcome), 64)
      : isValidCause(verdict.cause)
        ? verdict.cause
        : 'malformed cause';
    const message =
      `${taskId} failed (${label}) and the dispatch session cannot unblock it: ${reason}` +
      (detail ? `. Notes: ${detail}` : '');
    return {
      taskId,
      action: 'escalate',
      result: 'escalated',
      reason,
      ...(branch ? { branch } : {}),
      escalation: { taskId, message },
    };
  };

  /** Record a step that did not complete, then escalate. */
  const giveUp = (
    action: StepAction,
    result: 'refused' | 'failed',
    reason: string,
    branch?: string,
  ): PlaybookOutcome => {
    record(action, result, reason, branch);
    return escalate(`${action} ${result}: ${reason}`, branch);
  };

  const git = async (args: readonly string[], cwd: string): Promise<CommandResult> => {
    const sub = args[0];
    if (sub === undefined || !GIT_SUBCOMMANDS.has(sub)) {
      throw new Error(`the playbook does not run 'git ${String(sub)}'`);
    }
    if (args.includes('push') && !isSafeTaskPush(args, taskId)) {
      throw new Error('refusing a push that is not to the task branch');
    }
    return await deps.run('git', args, { cwd });
  };

  /** The worktree and the task branch checked out in it, or the reason there is none. */
  type Located = { worktree: string; branch: string } | { error: string };
  const locate = async (): Promise<Located> => {
    const worktree = path.join(deps.repoRoot, '.worktrees', taskId.toLowerCase());
    if (!(deps.exists ?? existsSync)(worktree)) {
      return { error: `no worktree at .worktrees/${taskId.toLowerCase()}` };
    }
    // Before git runs in it: a worktree whose .git points elsewhere would make git
    // read configuration and hooks from a place the agent controls.
    const notOwn = deps.ownWorktree(worktree);
    if (notOwn !== null) return { error: `the worktree is not trusted (${oneLine(notOwn, 120)})` };
    const current = await git(['branch', '--show-current'], worktree);
    const branch = current.status === 0 ? current.stdout.trim() : '';
    if (!isOwnTaskBranch(branch, taskId)) {
      return { error: `the worktree is not on the task's own branch ('${oneLine(branch, 80)}')` };
    }
    if (isProtectedBranch(branch, deps.protectedBranches)) {
      return { error: `the task branch '${oneLine(branch, 80)}' is protected by policy` };
    }
    if (verdict.pushedBranch && verdict.pushedBranch !== branch) {
      return { error: 'the recorded branch differs from the one checked out in the worktree' };
    }
    return { worktree, branch };
  };

  // A task parked on a decision is waiting for an answer, not broken: the
  // decisions step routes it, so there is nothing to message the planner about here.
  const parkedOn = (Array.isArray(verdict.decisionIds) ? verdict.decisionIds : []).filter(
    isValidDecisionId,
  );
  if (verdict.outcome === 'blocked' && parkedOn.length > 0) {
    const reason = `waiting on decision ${parkedOn.join(', ')}; routed by the decisions step`;
    record('escalate', 'escalated', reason);
    return { taskId, action: 'escalate', result: 'escalated', reason };
  }

  const c = classifyFailure(verdict);

  if (c.kind === 'escalate') return escalate(c.reason);

  const missing = REQUIRED_GRANTS[c.kind].filter((g) => !deps.operational.has(g));
  if (missing.length > 0) {
    return giveUp(c.kind, 'refused', `not permitted by policy (${missing.join(', ')})`);
  }

  if (c.kind === 'rebase-push' && deps.forcePushMode !== 'leaseOnOwnBranch') {
    return giveUp(
      c.kind,
      'refused',
      'not permitted by policy (allowForcePush is not leaseOnOwnBranch)',
    );
  }

  if (c.kind === 'requeue') {
    try {
      const r = deps.requeue(taskId);
      const reason = `re-queued as retry ${r.retryCount} (${c.cause})`;
      record('requeue', 'done', reason);
      return { taskId, action: 'requeue', result: 'done', reason };
    } catch (err) {
      return giveUp('requeue', 'refused', err instanceof Error ? err.message : String(err));
    }
  }

  const where = await locate();
  if ('error' in where) return giveUp(c.kind, 'refused', where.error);
  const { worktree, branch } = where;

  if (c.kind === 'retrigger-ci') {
    const commit = await git(
      ['commit', '--allow-empty', '-m', 'chore: retrigger CI on a fresh merge ref'],
      worktree,
    );
    if (commit.status !== 0) {
      const why = `empty commit failed: ${oneLine(commit.stderr, 200)}`;
      return giveUp('retrigger-ci', 'failed', why, branch);
    }
    const push = await git(['push', 'origin', `HEAD:refs/heads/${branch}`], worktree);
    if (push.status !== 0) {
      return giveUp('retrigger-ci', 'failed', `push failed: ${oneLine(push.stderr, 200)}`, branch);
    }
    const reason = 'pushed an empty commit';
    record('retrigger-ci', 'done', reason, branch);
    return { taskId, action: 'retrigger-ci', result: 'done', reason, branch };
  }

  // rebase-push
  const status = await git(['status', '--porcelain'], worktree);
  if (status.status !== 0 || status.stdout.trim() !== '') {
    return giveUp('rebase-push', 'refused', 'the worktree has uncommitted changes', branch);
  }
  const fetched = await git(['fetch', 'origin', 'main'], worktree);
  if (fetched.status !== 0) {
    return giveUp('rebase-push', 'failed', `fetch failed: ${oneLine(fetched.stderr, 200)}`, branch);
  }
  const rebased = await git(['rebase', 'origin/main'], worktree);
  if (rebased.status !== 0) {
    await git(['rebase', '--abort'], worktree);
    const why = `the rebase onto origin/main did not apply cleanly (${c.shape}); it was aborted`;
    return giveUp('rebase-push', 'failed', why, branch);
  }
  const pushed = await git(
    ['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${branch}`],
    worktree,
  );
  if (pushed.status !== 0) {
    return giveUp('rebase-push', 'failed', `push failed: ${oneLine(pushed.stderr, 200)}`, branch);
  }
  const reason = `rebased onto origin/main (${c.shape}) and lease-pushed`;
  record('rebase-push', 'done', reason, branch);
  return { taskId, action: 'rebase-push', result: 'done', reason, branch };
}
