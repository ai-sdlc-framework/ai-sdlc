/**
 * `cli-hierarchy pane-exited <session>` (AISDLC-1217, DEC-0392): the exit of a spawned
 * executor's pane posts to dispatch at once. A tmux `pane-exited` hook, installed by `spawn`,
 * runs this subcommand. It records a `failed/` diagnostic with cause `executor-exited`, puts
 * the claim back in `queue/`, clears the heartbeat and drops the roster entry, so a dead
 * executor is no longer found by the stall tick and aged out after a grace.
 *
 * `down` removes the hook before it asks a session to exit, so a requested stop never counts
 * as an exit. A second call for the same session finds nothing inflight and does nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  readHeartbeat,
  readInflightManifest,
  TASK_ID_RE,
  writeDiagnostic,
  writeManifest,
} from '../dispatch/board.js';
import type { DispatchVerdict } from '../dispatch/types.js';
import { readLoopState, saveLoopState } from './dispatch-loop.js';
import { listInflight } from './inflight.js';
import { readRosterChecked, writeRoster } from './roster.js';
import { hasSession, tmuxRun } from './tmux.js';
import type { CommandResult, CommandRunner, HierarchyDeps } from './types.js';
import { isSpawnedExecutorName } from './validate.js';

/** Cause code written on the failure record of an executor whose pane exited. */
export const EXECUTOR_EXITED_CAUSE = 'executor-exited';

const HOOK = 'pane-exited';

/** Install the exit hook on a spawned executor's window (window-scoped, never global). */
export function installPaneExitHook(
  run: CommandRunner,
  session: string,
  binPath: string,
): CommandResult {
  const cmd = `run-shell -b "node '${binPath}' pane-exited ${session}"`;
  return tmuxRun(run, ['set-hook', '-w', '-t', `=${session}:${session}`, HOOK, cmd]);
}

/** Remove the exit hook; a failure (window already gone) is harmless. */
export function removePaneExitHook(run: CommandRunner, session: string): CommandResult {
  return tmuxRun(run, ['set-hook', '-u', '-w', '-t', `=${session}:${session}`, HOOK]);
}

/** What {@link hierarchyPaneExited} did. */
export interface PaneExitResult {
  status: 'requeued' | 'noop';
  taskId?: string;
  reason?: string;
}

function hasVerdict(boardDir: string, taskId: string): boolean {
  return ['done', 'failed'].some((d) =>
    ['.verdict.json', '.completed.json', '.diagnostic.json'].some((s) =>
      existsSync(path.join(boardDir, d, `${taskId}${s}`)),
    ),
  );
}

function iterateNeeded(boardDir: string, taskId: string): boolean {
  try {
    const v = JSON.parse(
      readFileSync(path.join(boardDir, 'done', `${taskId}.verdict.json`), 'utf-8'),
    ) as DispatchVerdict;
    return v.outcome === 'iterate-needed';
  } catch {
    return false;
  }
}

/**
 * Record the exit of a spawned executor's pane.
 * @throws when `session` is not a spawned executor name.
 */
export function hierarchyPaneExited(session: string, deps: HierarchyDeps): PaneExitResult {
  if (!isSpawnedExecutorName(session)) {
    throw new Error(`'${session}' is not a spawned executor session name`);
  }
  if (hasSession(deps.run, session)) {
    return { status: 'noop', reason: 'the session is still live' };
  }
  const { roster } = readRosterChecked(deps.boardDir);
  const entry = roster.sessions.find((e) => e.name === session || e.tmuxSession === session);
  const held = listInflight(deps.boardDir).find(
    (i) => i.workerId === session || (entry?.taskId !== undefined && i.taskId === entry.taskId),
  );
  if (entry) {
    writeRoster(deps.boardDir, {
      ...roster,
      sessions: roster.sessions.filter((e) => e !== entry),
    });
  }
  if (!held || !TASK_ID_RE.test(held.taskId)) {
    return { status: 'noop', reason: 'no inflight claim is held by this session' };
  }
  const { taskId } = held;
  const manifest = readInflightManifest(deps.boardDir, taskId);
  if (manifest && iterateNeeded(deps.boardDir, taskId)) {
    const reason =
      'the claim stays: done/ holds an iterate-needed verdict, so the task goes back through `cli-dispatch reenter`, not the queue';
    deps.log(`executor '${session}' exited; ${taskId}: ${reason}`);
    return { status: 'noop', taskId, reason };
  }
  if (!manifest || hasVerdict(deps.boardDir, taskId)) {
    return { status: 'noop', taskId, reason: 'the claim already has a verdict' };
  }
  const heartbeat = readHeartbeat(deps.boardDir, taskId);
  const completedAt = deps.now().toISOString();
  const verdict: DispatchVerdict = {
    schemaVersion: 'v1',
    taskId,
    outcome: 'failed',
    completedAt,
    workerId: session,
    cause: EXECUTOR_EXITED_CAUSE,
    notes: `executor session '${session}' exited while holding the claim`,
    lastStep: heartbeat?.currentStep ?? 'unknown',
  };
  if (heartbeat?.workerKind) verdict.workerKind = heartbeat.workerKind;
  // Removes the inflight manifest, heartbeat and resume signal.
  writeDiagnostic(deps.boardDir, verdict);
  const next = { ...manifest };
  delete next.workerId;
  delete next.blockedBy;
  writeManifest(deps.boardDir, next);
  // The claim is already back in the queue: the tick must not run the playbook on this record.
  const state = readLoopState(deps.boardDir);
  state.handled.push(`failed:${taskId}:${completedAt}`);
  saveLoopState(deps.boardDir, state);
  deps.log(`executor '${session}' exited; returned ${taskId} to the queue`);
  return { status: 'requeued', taskId };
}
