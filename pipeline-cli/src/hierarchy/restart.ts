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
 * `restart` also takes `operator-dispatch` and `planner` (AISDLC-1104): the session is stopped
 * and started with its recorded model, mode and env, inflight manifests stay on the board, and
 * for dispatch the reconcile scheduler and webhook receiver are re-registered. `restartAll`
 * restarts dispatch and every idle executor, deferring busy executors to their task boundary.
 * `register` applies to executors only. The dispatch or planner session may run `restart`
 * (only dispatch may run `register`); the CLI runs the caller guard before calling in here.
 */

import { releaseInflight } from '../dispatch/board.js';
import { createSystemIdentity } from './caller-identity.js';
import { holdsInflight } from './clear.js';
import { stopSessionWindow } from './down.js';
import { listInflight } from './inflight.js';
import { schedulerUp } from './reconcile-scheduler.js';
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
import { webhookUp } from './webhook.js';
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
  /** Task the executor claimed in the instant before the stop; returned to `queue/`. */
  requeued?: string;
}

/** Seconds `--after-task` waits for a task boundary unless `waitSec` is given. */
export const DEFAULT_AFTER_TASK_WAIT_SEC = 1500;
const AFTER_TASK_POLL_MS = 5000;

function snapshot(entry: RosterEntry): Snapshot {
  return { pid: entry.pid, startedAt: entry.startedAt, paneId: entry.paneId };
}

/** The roster entry a name selects, which must be a modern-layout executor (any role for `restart`). */
function selectExecutor(
  roster: Roster,
  session: string,
  verb: string,
  anyRole = false,
): RosterEntry {
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
  if (!anyRole && entry.role !== 'executor') {
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

/**
 * Replace (or, with `next` null, drop) the one roster entry named `name`, taking every
 * other entry from a fresh read so a change made during a long wait is not lost.
 */
function replaceEntry(deps: HierarchyDeps, name: string, next: RosterEntry | null): void {
  const { roster } = readRosterChecked(deps.boardDir);
  const kept = roster.sessions.map((e) => (e.name === name ? next : e));
  if (next && !roster.sessions.some((e) => e.name === name)) kept.push(next);
  writeRoster(deps.boardDir, {
    ...roster,
    sessions: kept.filter((e): e is RosterEntry => e !== null),
  });
}

/** True when `pid` is `ancestor` or one of its descendants. */
function isSelfOrDescendant(
  pid: number,
  ancestor: number,
  parentPid: (pid: number) => number | null,
): boolean {
  const seen = new Set<number>();
  let cur: number | null = pid;
  for (let i = 0; i < 32 && cur !== null && cur > 1 && !seen.has(cur); i++) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = parentPid(cur);
  }
  return false;
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
  const entry = selectExecutor(roster, opts.session, 'restart', true);
  assertModel(entry.model, 'the roster model');
  assertPermissionMode(entry.permissionMode);

  const held = entry.role === 'executor' ? holdsInflight(deps.boardDir, entry.name) : undefined;
  if (held && !opts.afterTask) {
    throw new Error(
      `refusing to restart '${entry.name}': it holds ${held}, which is still inflight. Run again with --after-task to restart at the task boundary`,
    );
  }
  const waitedFor =
    opts.afterTask && entry.role === 'executor'
      ? await waitForTaskBoundary(entry, opts, deps)
      : undefined;

  const stop = await stopSessionWindow(entry, deps);
  if ('refused' in stop) {
    throw new Error(
      `refusing to restart '${entry.name}': ${stop.refused}. Nothing was stopped; fix the session, or run cli-hierarchy down --role ${entry.name} then cli-hierarchy up`,
    );
  }

  // A manifest claimed after the last check above would be stranded by the stop.
  const stranded = listInflight(deps.boardDir).find((i) => i.workerId === entry.name);
  const requeued =
    stranded && releaseInflight(deps.boardDir, stranded.taskId) ? stranded.taskId : undefined;
  if (requeued) deps.log(`returned ${requeued} to the queue`);

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
    replaceEntry(deps, entry.name, null);
    throw new Error(
      `${launched.failure}; '${entry.name}' was stopped and dropped from the roster. Run cli-hierarchy up to start it again`,
    );
  }
  const next = launched.entry;
  replaceEntry(deps, entry.name, next);
  deps.emit?.({
    type: 'HierarchySessionStarted',
    sessionName: next.name,
    sessionRole: next.role,
    sessionModel: next.model,
    sessionPermissionMode: next.permissionMode,
  });
  for (const w of warnings) deps.log(`warning: ${w}`);
  if (next.role === 'operator-dispatch') reRegisterDispatchServices(deps);
  deps.log(
    `restarted ${next.role} '${next.tmuxWindow}'${stop.forced ? ' (window closed after no exit)' : ''}; pid ${entry.pid} -> ${next.pid}`,
  );
  return {
    name: next.name,
    before: snapshot(entry),
    after: snapshot(next),
    ...(waitedFor ? { waitedFor } : {}),
    ...(requeued ? { requeued } : {}),
  };
}

/** After a dispatch restart: make sure the reconcile scheduler and, when a secret is set, the webhook receiver run. */
function reRegisterDispatchServices(deps: HierarchyDeps): void {
  try {
    schedulerUp(deps, deps.spawnScheduler);
  } catch (err) {
    deps.log(`warning: reconcile scheduler not started: ${(err as Error).message}`);
  }
  if (deps.env.AI_SDLC_WEBHOOK_SECRET) {
    try {
      webhookUp(deps);
    } catch (err) {
      deps.log(`warning: webhook receiver not started: ${(err as Error).message}`);
    }
  }
}

/** Result of `restart --all`. */
export interface RestartAllResult {
  restarted: RestartResult[];
  /** Busy executors restarted at their task boundary (waited for, as `--after-task` does). */
  deferred: string[];
  failed: { name: string; error: string }[];
}

/**
 * Restart dispatch and every executor: dispatch first, idle executors next, then each busy
 * executor at its task boundary. The planner is left alone. One failure does not stop the rest.
 */
export async function hierarchyRestartAll(
  opts: { waitSec?: number },
  deps: HierarchyDeps,
): Promise<RestartAllResult> {
  const { roster } = readRosterChecked(deps.boardDir);
  const dispatch = roster.sessions.filter((e) => e.role === 'operator-dispatch');
  const executors = roster.sessions.filter((e) => e.role === 'executor');
  const busy = executors.filter((e) => holdsInflight(deps.boardDir, e.name));
  const idle = executors.filter((e) => !busy.includes(e));
  const out: RestartAllResult = { restarted: [], deferred: [], failed: [] };
  const plan: [RosterEntry, boolean][] = [
    ...dispatch.map((e): [RosterEntry, boolean] => [e, false]),
    ...idle.map((e): [RosterEntry, boolean] => [e, false]),
    ...busy.map((e): [RosterEntry, boolean] => [e, true]),
  ];
  for (const [entry, defer] of plan) {
    try {
      const r = await hierarchyRestart(
        {
          session: entry.name,
          afterTask: defer,
          ...(opts.waitSec === undefined ? {} : { waitSec: opts.waitSec }),
        },
        deps,
      );
      out.restarted.push(r);
      if (defer) out.deferred.push(entry.name);
    } catch (err) {
      out.failed.push({ name: entry.name, error: (err as Error).message });
    }
  }
  return out;
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
  const parentPid = deps.parentPid ?? createSystemIdentity(deps.boardDir).parentPid;
  if (!pane.panePid || !isSelfOrDescendant(live.pid, pane.panePid, parentPid)) {
    return refuse(
      `pid ${live.pid} is not the tmux pane's process (pid ${pane.panePid}) or one of its descendants`,
      restartHint,
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
  replaceEntry(deps, entry.name, next);
  deps.log(`registered executor '${next.tmuxWindow}'; pid ${entry.pid} -> ${next.pid}`);
  return { name: next.name, before: snapshot(entry), after: snapshot(next) };
}
