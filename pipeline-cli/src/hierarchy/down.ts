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
import { readRosterChecked, writeRoster } from './roster.js';
import { splitSessionName } from './validate.js';
import {
  killPane,
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
 * Stop sessions. `role` matches a roster name (`executor-beta`) or a role
 * (`executor` selects every executor); without it every session is stopped.
 * @throws when `role` matches nothing.
 */
export async function hierarchyDown(
  options: { role?: string },
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

  const stopped: DownOutcome[] = [];
  const refused: { name: string; reason: string }[] = [];
  for (const entry of selected) {
    const isOpen = () => listWindows(deps.run, entry.tmuxSession).includes(entry.tmuxWindow);
    let forced = false;
    // Ownership and pane gate: a session `up` started, reached through a pane id that
    // still belongs to it. Run before the exit request and again before any forced close.
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
    const refuse = (verb: string, reason: string) => {
      refused.push({ name: entry.name, reason });
      deps.log(`warning: not ${verb} '${entry.name}': ${reason}`);
    };
    if (isOpen()) {
      const first = gate();
      if ('reason' in first) {
        refuse('stopping', first.reason);
        continue;
      }
      sendExit(deps.run, first.target);
      for (let i = 0; i < deps.pollAttempts && isOpen(); i++) await deps.sleep(deps.pollIntervalMs);
      if (isOpen()) {
        // The grace period is seconds long: a session could have been replaced meanwhile,
        // so check again immediately before the destructive call. A confirmed pane id is
        // closed by id (never reused); otherwise the window by name.
        const again = gate();
        if ('reason' in again) {
          refuse('closing', again.reason);
          continue;
        }
        if (entry.paneId) killPane(deps.run, again.target);
        else killWindow(deps.run, entry.tmuxSession, entry.tmuxWindow);
        forced = true;
      }
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
  return { stopped, refused };
}
