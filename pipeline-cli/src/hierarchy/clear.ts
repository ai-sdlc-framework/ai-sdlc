/**
 * `cli-hierarchy clear <executor-name>`: empty an executor's context between
 * tasks.
 *
 * The dispatch session sends `/clear` to the executor's tmux pane, waits for the
 * settle time, then types `/ai-sdlc executor` so the executor starts its loop
 * again. `/clear` keeps the session's name and permission mode and fires the
 * plugin's SessionStart hook, which re-injects the role from the roster.
 *
 * Safety:
 *  - The executor must be a running roster entry with the executor role; its
 *    name, window and pane id are validated before any tmux call.
 *  - An executor that holds an inflight manifest is never cleared: that would
 *    destroy the context of work in progress.
 *  - Keys go only to the pane the roster names, and only when tmux confirms the
 *    pane still belongs to the executor's window.
 *
 * The `hierarchy.clear` capability is `live` when the restart command was sent
 * and the executor reported back within the settle time, `degraded` otherwise.
 */

import path from 'node:path';

import { reportCapabilityOutcome } from '@ai-sdlc/reference';

import { readInflightManifest } from '../dispatch/board.js';
import type { EventEmitter } from './emit.js';
import { listInflight } from './inflight.js';
import { readRosterChecked, unsafeEntryReason } from './roster.js';
import { listWindows, resolveSendTarget } from './tmux.js';
import type { CommandRunner, RosterEntry } from './types.js';

/** Capability id for the executor context clear. */
export const HIERARCHY_CLEAR_CAPABILITY = 'hierarchy.clear';

/** Default wait, in milliseconds, between the two keystrokes and for the executor to report back. */
export const DEFAULT_SETTLE_MS = 8000;
/** Default spacing of the "did the executor report back" polls. */
export const DEFAULT_POLL_INTERVAL_MS = 500;

const EXECUTOR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PANE_ID_RE = /^%[0-9]+$/;

/** Collaborators of {@link clearExecutor}; every one is injected in tests. */
export interface ClearDeps {
  run: CommandRunner;
  boardDir: string;
  sleep: (ms: number) => Promise<void>;
  /** Records the `ExecutorContextCleared` event. */
  emit?: EventEmitter;
  /** Where capability state is written; default is `$ARTIFACTS_DIR`, else beside the board. */
  artifactsDir?: string;
  log?: (line: string) => void;
}

/** Inputs of {@link clearExecutor}. */
export interface ClearOptions {
  /** Roster name of the executor. */
  executor: string;
  /** Wait between the two keystrokes and for the executor to report back. */
  settleMs?: number;
  pollIntervalMs?: number;
  /** Task whose verdict triggered the clear; recorded on the event. */
  taskId?: string;
  /** Roster name of the dispatch session doing the clear; recorded as the event's worker. */
  workerId?: string;
}

/** What a clear did. */
export interface ClearResult {
  executor: string;
  paneId: string;
  /** The executor reported back within the settle time. */
  resumed: boolean;
  settleMs: number;
}

function artifactsDirFor(boardDir: string, override?: string): string {
  if (override !== undefined) return override;
  return process.env.ARTIFACTS_DIR ?? path.join(path.dirname(path.resolve(boardDir)), 'artifacts');
}

/** The line the executor prints when its loop (re)starts; the report-back signal. */
function reportBackMarker(name: string): string {
  return `[executor] I am '${name}'`;
}

/** How many times the marker is visible in the pane right now (0 when the pane cannot be read). */
function countMarker(run: CommandRunner, target: string, name: string): number {
  const r = run('tmux', ['capture-pane', '-p', '-t', target]);
  if (r.status !== 0) return 0;
  return r.stdout.split(reportBackMarker(name)).length - 1;
}

function holdsInflight(boardDir: string, name: string): string | undefined {
  for (const item of listInflight(boardDir)) {
    if (item.workerId === name || readInflightManifest(boardDir, item.taskId)?.workerId === name) {
      return item.taskId;
    }
  }
  return undefined;
}

function type(run: CommandRunner, target: string, text: string): string | undefined {
  const typed = run('tmux', ['send-keys', '-t', target, '-l', '--', text]);
  if (typed.status !== 0) return typed.stderr.trim() || 'tmux send-keys failed';
  const sent = run('tmux', ['send-keys', '-t', target, 'Enter']);
  if (sent.status !== 0) return sent.stderr.trim() || 'tmux send-keys failed';
  return undefined;
}

function reportClear(deps: ClearDeps, outcome: 'live' | 'degraded', reason?: string): void {
  reportCapabilityOutcome(HIERARCHY_CLEAR_CAPABILITY, outcome, {
    artifactsDir: artifactsDirFor(deps.boardDir, deps.artifactsDir),
    ...(reason !== undefined ? { reason } : {}),
  });
}

/**
 * Clear an executor's context and restart its loop.
 * @throws, sending nothing, when the name or pane id is invalid, the executor is
 *   not a running roster executor, its window is not open, or it holds an
 *   inflight manifest. Throws after the first keystroke when a send fails.
 */
export async function clearExecutor(opts: ClearOptions, deps: ClearDeps): Promise<ClearResult> {
  const name = opts.executor;
  if (typeof name !== 'string' || !EXECUTOR_NAME_RE.test(name)) {
    throw new Error(`'${String(name)}' is not a valid executor name`);
  }
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isInteger(settleMs) || settleMs < 0) {
    throw new Error('the settle time must be a whole number of milliseconds');
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error('the poll interval must be a positive whole number of milliseconds');
  }

  const { roster } = readRosterChecked(deps.boardDir);
  const entry: RosterEntry | undefined = roster.sessions.find(
    (e) => e.name === name && e.role === 'executor',
  );
  if (!entry) throw new Error(`'${name}' is not an executor in the roster`);
  if (entry.status !== 'running') {
    throw new Error(`executor '${name}' is not running (status ${entry.status})`);
  }
  const unsafe = unsafeEntryReason(entry);
  if (unsafe) throw new Error(`refusing to clear '${name}': it ${unsafe}`);
  if (!PANE_ID_RE.test(entry.paneId)) {
    throw new Error(`refusing to clear '${name}': the roster has no valid pane id`);
  }
  const held = holdsInflight(deps.boardDir, name);
  if (held) {
    throw new Error(`refusing to clear '${name}': it holds ${held}, which is still inflight`);
  }
  if (!listWindows(deps.run, entry.tmuxSession).includes(entry.tmuxWindow)) {
    throw new Error(`the window for '${name}' is not open; start it with cli-hierarchy up`);
  }

  const target = resolveSendTarget(deps.run, entry.tmuxSession, entry.tmuxWindow, entry.paneId);
  const before = countMarker(deps.run, target, name);

  const clearFailure = type(deps.run, target, '/clear');
  if (clearFailure) {
    reportClear(deps, 'degraded', `could not send /clear to '${name}': ${clearFailure}`);
    throw new Error(`could not send /clear to '${name}': ${clearFailure}`);
  }
  await deps.sleep(settleMs);
  const restartFailure = type(deps.run, target, '/ai-sdlc executor');
  if (restartFailure) {
    reportClear(deps, 'degraded', `could not restart '${name}': ${restartFailure}`);
    throw new Error(`could not send /ai-sdlc executor to '${name}': ${restartFailure}`);
  }

  // The executor reports back by printing its identity line again.
  let resumed = false;
  const polls = Math.max(1, Math.ceil(settleMs / pollIntervalMs));
  for (let i = 0; i < polls && !resumed; i++) {
    await deps.sleep(pollIntervalMs);
    resumed = countMarker(deps.run, target, name) > before;
  }

  if (resumed) reportClear(deps, 'live');
  else {
    reportClear(
      deps,
      'degraded',
      `'${name}' did not report back within ${settleMs} ms of the restart command`,
    );
  }
  deps.emit?.({
    type: 'ExecutorContextCleared',
    executor: name,
    paneId: entry.paneId,
    resumed,
    settleMs,
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.workerId ? { workerId: opts.workerId } : {}),
  });
  deps.log?.(
    `cleared '${name}'${resumed ? '' : ' (it did not report back within the settle time)'}`,
  );
  return { executor: name, paneId: entry.paneId, resumed, settleMs };
}
