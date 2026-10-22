/**
 * `cli-hierarchy executor-start`: everything an executor does before it has a
 * task, in one deterministic call that costs no model calls while it waits.
 *
 *  1. Identify the session: the nearest ancestor process that is a running,
 *     claude-process roster entry, and it must be an executor. The name is used
 *     exactly as the roster has it.
 *  2. Check the working directory is the repository of the roster's project.
 *  3. Check the instructing sender is the roster's dispatch session (`check-sender`,
 *     AISDLC-764): it always runs, so it cannot be skipped. The sender pid or ref the
 *     harness reports is passed in; without either the check accepts and logs a loud UNCHECKED START warning.
 *  4. When the board is held (`cli-hierarchy hold`), print the reason and claim nothing.
 *     Otherwise claim the next eligible task under that name, blocking up to `waitSec`
 *     seconds (`cli-dispatch claim --wait`).
 *  5. Write `inflight/<task>.state.json` naming the worker, before returning and so
 *     before any model call: the lease-push hook binds an executor to its task by
 *     that heartbeat, so it must hold from the first push. A write failure throws.
 *  6. Run the lease-push preflight (AISDLC-798) on the new claim and print what the
 *     PreToolUse hook would refuse later (missing launch env, a second claim, a missing
 *     heartbeat), so a misconfigured executor is caught at claim time.
 *
 * Later instruction messages are still checked with `cli-hierarchy check-sender`.
 */

import { now } from '../clock.js';
import { writeHeartbeat } from '../dispatch/board.js';
import { claimWithWait } from '../dispatch/claim-wait.js';
import { formatResumeFeedback } from '../dispatch/resume.js';
import type { DispatchManifest } from '../dispatch/types.js';
import { resolveCaller, type IdentityDeps } from './caller-identity.js';
import { claimPreflight, type LeasePreflight } from './lease-preflight.js';
import { readHold } from './hold.js';
import { checkDispatchSender, checkRepoMatch, rosterProject } from './peer-guard.js';
import { readRosterChecked } from './roster.js';
import type { GitRunner } from './trusted-root.js';

/** Default seconds an idle executor blocks on the board before it hibernates. */
export const DEFAULT_EXECUTOR_WAIT_SEC = 1500;
/** Seconds an idle executor hibernates when it cannot clear itself (`emptyQueueHibernateSec`). */
export const DEFAULT_EMPTY_QUEUE_HIBERNATE_SEC = 1800;

/** Inputs of {@link executorStart}. */
export interface ExecutorStartOptions {
  boardDir: string;
  cwd: string;
  /** Seconds to wait for an eligible task (default {@link DEFAULT_EXECUTOR_WAIT_SEC}). */
  waitSec?: number;
  /** Pid the harness reports for the sender of the instruction (check-sender). */
  senderPid?: number;
  /** Session ref the harness reports for the sender of the instruction (check-sender). */
  senderRef?: string;
}

/** Collaborators; every one is replaceable in tests. */
export interface ExecutorStartDeps {
  identity: IdentityDeps;
  repoGit?: GitRunner;
  /** Replaces the blocking claim (tests). */
  claim?: typeof claimWithWait;
  /** Replaces the heartbeat write (tests). */
  heartbeat?: typeof writeHeartbeat;
  /** Replaces the lease-push preflight (tests). */
  preflight?: typeof claimPreflight;
  /** The session env the hook would see (default process.env). */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** What {@link executorStart} found. */
export interface ExecutorStartResult {
  name: string;
  project: string;
  /** The dispatch session's roster name, or '' when there is none. */
  dispatch: string;
  /** The claimed task, or null when the wait lapsed with nothing eligible or the board is held. */
  taskId: string | null;
  /** The hold reason when the board is held (AISDLC-899); nothing was claimed. */
  held?: string;
  manifest?: DispatchManifest;
  /** The lease-push preflight of the claim; absent when nothing was claimed. */
  leasePreflight?: LeasePreflight;
}

/**
 * @throws when this session is not a running executor of the roster, the roster
 *   is unusable, or the working directory is not the project's repository.
 */
export async function executorStart(
  opts: ExecutorStartOptions,
  deps: ExecutorStartDeps,
): Promise<ExecutorStartResult> {
  const self = resolveCaller(deps.identity);
  if (!self || self.role !== 'executor') {
    throw new Error('this session is not a running executor in the roster');
  }
  const { roster } = readRosterChecked(opts.boardDir);
  const dispatch =
    roster.sessions.find((s) => s.role === 'operator-dispatch' && s.status === 'running')?.name ??
    '';
  const project = rosterProject(roster.sessions);
  if (!project.ok) throw new Error(project.reason);
  const repo = checkRepoMatch({
    cwd: opts.cwd,
    boardDir: opts.boardDir,
    project: project.project,
    ...(deps.repoGit ? { git: deps.repoGit } : {}),
  });
  if (!repo.ok) throw new Error(repo.reason);
  const sender = checkDispatchSender(roster.sessions, {
    ...(opts.senderPid === undefined ? {} : { pid: opts.senderPid }),
    ...(opts.senderRef === undefined ? {} : { ref: opts.senderRef }),
  });
  if (!sender.ok) throw new Error(sender.reason);
  if (sender.warning !== undefined) {
    // No claim: the start cannot say who issued it (AISDLC-1025).
    throw new Error(
      `unchecked-start: no --sender-pid or --sender-ref was given, so the sender is unverified; nothing claimed. Report 'unchecked-start' to ${dispatch || 'dispatch'} and pass the pid or ref the harness reports.`,
    );
  }

  // The identity line is how `cli-hierarchy clear` sees an executor report back.
  deps.log?.(
    `[executor] I am '${self.name}' (project '${project.project}'); dispatch session is '${dispatch || 'none'}'`,
  );
  const hold = readHold(opts.boardDir);
  if (hold) {
    deps.log?.(`[executor] BOARD HELD: ${hold.reason} (since ${hold.since}); not claiming.`);
    return { name: self.name, project: project.project, dispatch, taskId: null, held: hold.reason };
  }
  const result = await (deps.claim ?? claimWithWait)(opts.boardDir, 'in-session-agent', {
    waitSec: opts.waitSec ?? DEFAULT_EXECUTOR_WAIT_SEC,
    workerId: self.name,
  });
  // A resumed task (AISDLC-738) carries a feedback note: surface it before the
  // executor runs the task, ahead of the final JSON line.
  if (result.claimed && result.manifest?.resume) {
    deps.log?.(
      `[executor] RESUMED TASK ${result.manifest.taskId} - feedback to address:\n${formatResumeFeedback(result.manifest.resume)}`,
    );
  }
  if (result.claimed && result.manifest) {
    const stamp = now().toISOString();
    try {
      (deps.heartbeat ?? writeHeartbeat)(opts.boardDir, {
        taskId: result.manifest.taskId,
        workerId: self.name,
        workerKind: 'in-session-agent',
        currentStep: 'claimed',
        startedAt: stamp,
        lastHeartbeat: stamp,
      });
    } catch (err) {
      throw new Error(
        `claimed ${result.manifest.taskId} but could not write its inflight heartbeat (the lease-push hook binds this session to the task by it): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  let leasePreflight: LeasePreflight | undefined;
  if (result.claimed && result.manifest) {
    leasePreflight = (deps.preflight ?? claimPreflight)(
      opts.boardDir,
      result.manifest.taskId,
      deps.env ?? process.env,
      [opts.cwd],
    );
    deps.log?.(`[executor] ${leasePreflight.message}`);
  }
  return {
    name: self.name,
    project: project.project,
    dispatch,
    taskId: result.claimed && result.manifest ? result.manifest.taskId : null,
    ...(result.claimed && result.manifest ? { manifest: result.manifest } : {}),
    ...(leasePreflight ? { leasePreflight } : {}),
  };
}
