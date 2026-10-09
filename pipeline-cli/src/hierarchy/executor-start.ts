/**
 * `cli-hierarchy executor-start`: everything an executor does before it has a
 * task, in one deterministic call that costs no model calls while it waits.
 *
 *  1. Identify the session: the nearest ancestor process that is a running,
 *     claude-process roster entry, and it must be an executor. The name is used
 *     exactly as the roster has it.
 *  2. Check the working directory is the repository of the roster's project.
 *  3. Claim the next eligible task under that name, blocking up to `waitSec`
 *     seconds (`cli-dispatch claim --wait`).
 *
 * The sender check stays with the executor's instruction handling: it needs the
 * pid or ref the harness reports for a message, which only exists per message.
 */

import { claimWithWait } from '../dispatch/claim-wait.js';
import type { DispatchManifest } from '../dispatch/types.js';
import { resolveCaller, type IdentityDeps } from './caller-identity.js';
import { checkRepoMatch, rosterProject } from './peer-guard.js';
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
}

/** Collaborators; every one is replaceable in tests. */
export interface ExecutorStartDeps {
  identity: IdentityDeps;
  repoGit?: GitRunner;
  /** Replaces the blocking claim (tests). */
  claim?: typeof claimWithWait;
  log?: (line: string) => void;
}

/** What {@link executorStart} found. */
export interface ExecutorStartResult {
  name: string;
  project: string;
  /** The dispatch session's roster name, or '' when there is none. */
  dispatch: string;
  /** The claimed task, or null when the wait lapsed with nothing eligible. */
  taskId: string | null;
  manifest?: DispatchManifest;
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

  // The identity line is how `cli-hierarchy clear` sees an executor report back.
  deps.log?.(
    `[executor] I am '${self.name}' (project '${project.project}'); dispatch session is '${dispatch || 'none'}'`,
  );
  const result = await (deps.claim ?? claimWithWait)(opts.boardDir, 'in-session-agent', {
    waitSec: opts.waitSec ?? DEFAULT_EXECUTOR_WAIT_SEC,
    workerId: self.name,
  });
  return {
    name: self.name,
    project: project.project,
    dispatch,
    taskId: result.claimed && result.manifest ? result.manifest.taskId : null,
    ...(result.claimed && result.manifest ? { manifest: result.manifest } : {}),
  };
}
