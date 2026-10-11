/**
 * `cli-hierarchy restart <session>` and `cli-hierarchy register <session>`: refresh or
 * re-attach ONE executor without the full `down` plus `up` cycle, which would also stop
 * the dispatch session and return every inflight task to the queue.
 *
 * - `restart` stops the named executor and starts it again with the model, permission
 *   mode and launch environment recorded in its roster entry, then replaces that one entry
 *   (pid, pane, started time) in a single roster write. Other entries are never touched.
 *   It refuses while the executor holds a claimed task unless `afterTask` is set, which
 *   waits for the task boundary first.
 * - `register` re-records an executor that is already running again under a new pid (it was
 *   restarted by hand). It first checks the tmux pane, the ownership marker, the launch
 *   environment of the pane's command and a live harness session of that name.
 *
 * Both are dispatch-session commands and apply to executors only; the CLI runs the caller
 * guard before calling in here.
 */

import { holdsInflight } from './clear.js';
import { stopSessionWindow } from './down.js';
import { readSessionRegistry } from './registry.js';
import {
  defaultProjectForBoard,
  isLegacyLayoutEntry,
  readRosterChecked,
  writeRoster,
} from './roster.js';
import { readNvmrc } from './node-pin.js';
import { ownershipRefusal, paneInfo, paneStartCommand, windowLive } from './tmux.js';
import type { HierarchyDeps, Roster, RosterEntry } from './types.js';
import { defaultIsAlive, hasLaunchEnv, launchSession, ROLE_PROMPT } from './up.js';
import { assertModel, assertPermissionMode, splitSessionName } from './validate.js';

/** Options for `restart`. */
export interface RestartOptions {
  /** Roster name, tmux window or unqualified name (`executor-beta`) of the executor. */
  session: string;
  /** Wait for the task the executor holds to finish instead of refusing. */
  afterTask?: boolean;
  /** Longest wait for `afterTask`, in seconds (default 1500). */
  waitSec?: number;
}

/** The roster fields a restart or register changes. */
interface Snapshot {
  pid: number;
  startedAt: string;
  paneId: string;
}

/** Result of `restart` and `register`. */
export interface RestartResult {
  name: string;
  before: Snapshot;
  after: Snapshot;
  /** `register` found the roster already correct and wrote nothing. */
  unchanged?: boolean;
  /** Task the executor held that `--after-task` waited for. */
  waitedFor?: string;
}

/** Seconds `--after-task` waits for a task boundary unless `waitSec` is given. */
export const DEFAULT_AFTER_TASK_WAIT_SEC = 1500;
const AFTER_TASK_POLL_MS = 5000;

function snapshot(entry: RosterEntry): Snapshot {
  return { pid: entry.pid, startedAt: entry.startedAt, paneId: entry.paneId };
}

/** The roster entry a name selects, which must be a modern-layout executor. */
function selectExecutor(roster: Roster, session: string, verb: string): RosterEntry {
  const entry = roster.sessions.find(
    (e) =>
      e.name === session ||
      e.tmuxWindow === session ||
      splitSessionName(e.tmuxWindow)?.bare === session,
  );
  if (!entry) {
    throw new Error(
      `no session named '${session}' in the roster; run cli-hierarchy status for the names, or cli-hierarchy up to start it`,
    );
  }
  if (entry.role !== 'executor') {
    throw new Error(
      `refusing to ${verb} '${entry.name}': ${verb} applies to executors only (this is the ${entry.role} session). To refresh it run cli-hierarchy down --role ${entry.name}, then cli-hierarchy up`,
    );
  }
  if (isLegacyLayoutEntry(entry)) {
    throw new Error(
      `refusing to ${verb} '${entry.name}': the roster uses the old single-session layout; run cli-hierarchy down, then cli-hierarchy up`,
    );
  }
  return entry;
}

/** Block until the executor holds no claimed task; returns the task it was waiting for. */
async function waitForTaskBoundary(
  entry: RosterEntry,
  opts: RestartOptions,
  deps: HierarchyDeps,
): Promise<string | undefined> {
  const first = holdsInflight(deps.boardDir, entry.name);
  if (!first) return undefined;
  const waitSec = opts.waitSec ?? DEFAULT_AFTER_TASK_WAIT_SEC;
  deps.log(`'${entry.name}' holds ${first}; waiting for the task boundary (--after-task)`);
  for (let i = 0; i < Math.ceil((waitSec * 1000) / AFTER_TASK_POLL_MS); i++) {
    await deps.sleep(AFTER_TASK_POLL_MS);
    if (!holdsInflight(deps.boardDir, entry.name)) return first;
  }
  throw new Error(
    `'${entry.name}' still holds ${holdsInflight(deps.boardDir, entry.name) ?? first} after ${waitSec} s; nothing was stopped. Run again with a larger --wait, or check the task with cli-hierarchy status`,
  );
}

/**
 * Stop one executor and start it again, replacing only its roster entry.
 * @throws when the target is not an executor, holds a task without `afterTask`, cannot be
 *   stopped safely, or cannot be started (the dead entry is then dropped from the roster).
 */
export async function hierarchyRestart(
  opts: RestartOptions,
  deps: HierarchyDeps,
): Promise<RestartResult> {
  const { roster } = readRosterChecked(deps.boardDir);
  const entry = selectExecutor(roster, opts.session, 'restart');
  assertModel(entry.model, 'the roster model');
  assertPermissionMode(entry.permissionMode);

  const held = holdsInflight(deps.boardDir, entry.name);
  if (held && !opts.afterTask) {
    throw new Error(
      `refusing to restart '${entry.name}': it holds ${held}, which is still inflight. Run again with --after-task to restart at the task boundary`,
    );
  }
  const waitedFor = opts.afterTask ? await waitForTaskBoundary(entry, opts, deps) : undefined;

  const stop = await stopSessionWindow(entry, deps);
  if ('refused' in stop) {
    throw new Error(
      `refusing to restart '${entry.name}': ${stop.refused}. Nothing was stopped; fix the session, or run cli-hierarchy down --role ${entry.name} then cli-hierarchy up`,
    );
  }

  const project = entry.project ?? defaultProjectForBoard(deps.boardDir);
  const warnings: string[] = [];
  const others = roster.sessions.filter((e) => e !== entry);
  const launched = await launchSession(
    {
      role: entry.role,
      name: entry.tmuxWindow,
      bare: splitSessionName(entry.tmuxWindow)?.bare ?? entry.tmuxWindow,
      model: entry.model,
      permissionMode: entry.permissionMode,
      prompt: ROLE_PROMPT[entry.role],
    },
    project,
    deps,
    new Set(others.map((e) => e.name)),
    warnings,
    readNvmrc(deps.cwd),
  );
  if ('failure' in launched) {
    // The old process is gone; do not leave its dead pid in the roster.
    writeRoster(deps.boardDir, { ...roster, sessions: others });
    throw new Error(
      `${launched.failure}; '${entry.name}' was stopped and dropped from the roster. Run cli-hierarchy up to start it again`,
    );
  }
  const next = launched.entry;
  writeRoster(deps.boardDir, {
    ...roster,
    sessions: roster.sessions.map((e) => (e === entry ? next : e)),
  });
  deps.emit?.({ type: 'HierarchySessionStarted', sessionName: next.name, sessionRole: next.role });
  for (const w of warnings) deps.log(`warning: ${w}`);
  deps.log(
    `restarted executor '${next.tmuxWindow}'${stop.forced ? ' (window closed after no exit)' : ''}; pid ${entry.pid} -> ${next.pid}`,
  );
  return {
    name: next.name,
    before: snapshot(entry),
    after: snapshot(next),
    ...(waitedFor ? { waitedFor } : {}),
  };
}

/**
 * Re-record an executor whose process was restarted by hand, after checking that the tmux
 * pane is ours and a live harness session of that name exists.
 * @throws with the failed check and the next step.
 */
export function hierarchyRegister(opts: { session: string }, deps: HierarchyDeps): RestartResult {
  const { roster } = readRosterChecked(deps.boardDir);
  const entry = selectExecutor(roster, opts.session, 'register');
  const refuse = (why: string, next: string): never => {
    throw new Error(`refusing to register '${entry.name}': ${why}. ${next}`);
  };
  const restartHint = `Start it with cli-hierarchy restart ${entry.name}`;

  if (!windowLive(deps.run, entry.tmuxSession, entry.tmuxWindow)) {
    return refuse(`its tmux window '${entry.tmuxWindow}' is not open`, restartHint);
  }
  const unowned = ownershipRefusal(deps.run, entry);
  if (unowned) return refuse(unowned, restartHint);
  const pane = paneInfo(deps.run, entry.tmuxSession, entry.tmuxWindow);
  if (!pane.paneId) return refuse('its tmux pane cannot be read', restartHint);
  const command = paneStartCommand(deps.run, entry.tmuxSession, entry.tmuxWindow);
  if (!hasLaunchEnv(command, entry.tmuxWindow, entry.role)) {
    return refuse(
      "the pane's command does not carry this session's AI_SDLC_HIERARCHY_SESSION and AI_SDLC_HIERARCHY_ROLE",
      restartHint,
    );
  }
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const live = readSessionRegistry(deps.registryDir)
    .filter(
      (s) =>
        (s.name === entry.name || s.name === entry.tmuxWindow) &&
        isAlive(s.pid) &&
        (s.cwd === undefined || s.cwd === deps.cwd),
    )
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!live) {
    return refuse(
      `no live harness session is registered as '${entry.name}'`,
      `Wait for it to start, or run cli-hierarchy restart ${entry.name}`,
    );
  }
  if (roster.sessions.some((e) => e !== entry && e.pid === live.pid)) {
    return refuse(
      `pid ${live.pid} already belongs to another roster entry`,
      'Check cli-hierarchy status',
    );
  }
  if (live.pid === entry.pid && pane.paneId === entry.paneId && entry.status === 'running') {
    deps.log(`'${entry.name}' is already registered (pid ${entry.pid}); nothing changed`);
    return { name: entry.name, before: snapshot(entry), after: snapshot(entry), unchanged: true };
  }
  const next: RosterEntry = {
    ...entry,
    pid: live.pid,
    paneId: pane.paneId,
    startedAt:
      live.startedAt > 0 ? new Date(live.startedAt).toISOString() : deps.now().toISOString(),
    status: 'running',
  };
  writeRoster(deps.boardDir, {
    ...roster,
    sessions: roster.sessions.map((e) => (e === entry ? next : e)),
  });
  deps.log(`registered executor '${next.tmuxWindow}'; pid ${entry.pid} -> ${next.pid}`);
  return { name: next.name, before: snapshot(entry), after: snapshot(next) };
}
