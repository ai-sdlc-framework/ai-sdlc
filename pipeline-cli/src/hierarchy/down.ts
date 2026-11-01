/**
 * `cli-hierarchy down`: end sessions cleanly, return their inflight manifests
 * to the queue, close their windows and drop them from the roster.
 *
 * Targets come from each roster entry's own `tmuxSession` / `tmuxWindow`, so the
 * same code stops the current layout (one tmux session per agent) and a roster
 * written by the old layout (windows of the shared `ai-sdlc-hierarchy` session).
 * Closing an agent's only window ends its session.
 *
 * A session is typed into or closed only when it carries the ownership marker that
 * `up` sets and its recorded pane still belongs to it; both are checked before the
 * exit request AND again before a forced close. An entry that fails either check is
 * refused: it stays in the roster, its inflight work is untouched, and `down` goes on
 * with the others. Entries of the old layout predate the marker and have no ownership
 * check.
 */

import { releaseInflight } from '../dispatch/board.js';
import { listInflight } from './inflight.js';
import { schedulerDown } from './reconcile-scheduler.js';
import { readRosterChecked, writeRoster } from './roster.js';
import { isSpawnedExecutorNameOf, splitSessionName } from './validate.js';
import {
  killPane,
  hasSession,
  killSession,
  killWindow,
  listWindows,
  ownershipRefusal,
  resolveSendTarget,
  sendExit,
} from './tmux.js';
import type { HierarchyDeps, RosterEntry } from './types.js';

/** What happened to one session. */
export interface DownOutcome {
  name: string;
  role: string;
  /** Task whose manifest went back to `queue/`, when the session held one. */
  requeued?: string;
  /** True when the window had to be closed because the session did not exit. */
  forced: boolean;
}

/** Result of `down`. */
export interface DownResult {
  stopped: DownOutcome[];
  /** Sessions left alone, with the reason: not started by `up`, or a stale pane id. */
  refused: { name: string; reason: string }[];
}

/**
 * End one session's tmux window: ask it to exit, wait, then close it by pane id when it
 * stays open. A window that is already gone counts as stopped. Refuses (and touches
 * nothing) when the session lacks the ownership marker or its recorded pane no longer
 * belongs to it; both are checked before the exit request and again before a forced close.
 */
export async function stopSessionWindow(
  entry: RosterEntry,
  deps: HierarchyDeps,
): Promise<{ forced: boolean } | { refused: string; verb: 'stopping' | 'closing' }> {
  const isOpen = () => listWindows(deps.run, entry.tmuxSession).includes(entry.tmuxWindow);
  // Ownership and pane gate: a session `up` started, reached through a pane id that
  // still belongs to it.
  const gate = (): { target: string } | { reason: string } => {
    const refusal = ownershipRefusal(deps.run, entry);
    if (refusal) return { reason: refusal };
    try {
      return {
        target: resolveSendTarget(deps.run, entry.tmuxSession, entry.tmuxWindow, entry.paneId),
      };
    } catch (err) {
      return { reason: (err as Error).message };
    }
  };
  if (!isOpen()) return { forced: false };
  const first = gate();
  if ('reason' in first) return { refused: first.reason, verb: 'stopping' };
  sendExit(deps.run, first.target);
  for (let i = 0; i < deps.pollAttempts && isOpen(); i++) await deps.sleep(deps.pollIntervalMs);
  if (!isOpen()) return { forced: false };
  // The grace period is seconds long: a session could have been replaced meanwhile,
  // so check again immediately before the destructive call. A confirmed pane id is
  // closed by id (never reused); otherwise the window by name.
  const again = gate();
  if ('reason' in again) return { refused: again.reason, verb: 'closing' };
  if (entry.paneId) killPane(deps.run, again.target);
  else killWindow(deps.run, entry.tmuxSession, entry.tmuxWindow);
  return { forced: true };
}

/**
 * Stop sessions. `role` matches a roster name (`executor-beta`) or a role
 * (`executor` selects every executor); without it every session is stopped.
 * @throws when `role` matches nothing.
 */
export async function hierarchyDown(
  options: { role?: string; callerName?: string },
  deps: HierarchyDeps,
): Promise<DownResult> {
  const { roster, rejected } = readRosterChecked(deps.boardDir);
  for (const r of rejected) deps.log(`warning: ${r}; not touched`);
  const selected: RosterEntry[] = options.role
    ? roster.sessions.filter(
        (e) =>
          e.name === options.role ||
          e.tmuxWindow === options.role ||
          e.role === options.role ||
          // The unqualified role name (`executor-beta`) selects it within this roster only.
          splitSessionName(e.tmuxWindow)?.bare === options.role,
      )
    : [...roster.sessions];
  if (options.role && selected.length === 0) {
    throw new Error(`no session named or with role '${options.role}' in the roster`);
  }

  const self = options.callerName ? selected.find((e) => e.name === options.callerName) : undefined;
  if (self) {
    throw new Error(
      `refusing to stop '${self.name}': it is the calling session, and stopping it would kill this command before it finishes. Ask another session (the planner for dispatch, dispatch for the planner) to run cli-hierarchy down ${self.name}, or use restart for a session that should come back`,
    );
  }
  // Executors first, then dispatch, the planner last, so an interrupted run never
  // orphans the executors (AISDLC-1106). The sort is stable within a rank.
  const rank = (e: RosterEntry): number =>
    e.role === 'planner' ? 2 : e.role === 'operator-dispatch' ? 1 : 0;
  selected.sort((a, b) => rank(a) - rank(b));

  const stopped: DownOutcome[] = [];
  const refused: { name: string; reason: string }[] = [];
  for (const entry of selected) {
    const stop = await stopSessionWindow(entry, deps);
    if ('refused' in stop) {
      refused.push({ name: entry.name, reason: stop.refused });
      deps.log(`warning: not ${stop.verb} '${entry.name}': ${stop.refused}`);
      continue;
    }
    const { forced } = stop;
    // AISDLC-1117: an ephemeral executor's session must not outlive its roster entry.
    if (
      entry.taskId !== undefined &&
      isSpawnedExecutorNameOf(entry.tmuxSession, entry.taskId) &&
      hasSession(deps.run, entry.tmuxSession)
    ) {
      killSession(deps.run, entry.tmuxSession);
    }
    const held = listInflight(deps.boardDir).find((i) => i.workerId === entry.name);
    let requeued: string | undefined;
    if (held && releaseInflight(deps.boardDir, held.taskId)) requeued = held.taskId;

    roster.sessions = roster.sessions.filter((e) => e !== entry);
    writeRoster(deps.boardDir, roster);
    stopped.push({ name: entry.name, role: entry.role, requeued, forced });
    deps.log(
      `stopped ${entry.role} '${entry.name}'${forced ? ' (window closed after no exit)' : ''}${requeued ? `; returned ${requeued} to the queue` : ''}`,
    );
  }
  // Stopping the whole hierarchy also stops its reconcile scheduler (AISDLC-932).
  if (!options.role) schedulerDown(deps);
  return { stopped, refused };
}
