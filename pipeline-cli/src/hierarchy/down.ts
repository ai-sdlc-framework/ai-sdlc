/**
 * `cli-hierarchy down`: end sessions cleanly, return their inflight manifests
 * to the queue, close their windows and drop them from the roster.
 *
 * Targets come from each roster entry's own `tmuxSession` / `tmuxWindow`, so the
 * same code stops the current layout (one tmux session per agent) and a roster
 * written by the old layout (windows of the shared `ai-sdlc-hierarchy` session).
 * Closing an agent's only window ends its session.
 */

import { releaseInflight } from '../dispatch/board.js';
import { listInflight } from './inflight.js';
import { readRosterChecked, writeRoster } from './roster.js';
import { killWindow, listWindows, ownershipRefusal, resolveSendTarget, sendExit } from './tmux.js';
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
        (e) => e.name === options.role || e.tmuxWindow === options.role || e.role === options.role,
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
    if (isOpen()) {
      // Before any keys are sent or window closed: only a session `up` started, and
      // only through a pane id that still belongs to it. A refused entry stays in the
      // roster and its inflight work is not touched.
      let target: string | undefined;
      let reason = ownershipRefusal(deps.run, entry);
      if (!reason) {
        try {
          target = resolveSendTarget(deps.run, entry.tmuxSession, entry.tmuxWindow, entry.paneId);
        } catch (err) {
          reason = (err as Error).message;
        }
      }
      if (reason || target === undefined) {
        const why = reason ?? 'could not resolve the pane to send keys to';
        refused.push({ name: entry.name, reason: why });
        deps.log(`warning: not stopping '${entry.name}': ${why}`);
        continue;
      }
      sendExit(deps.run, target);
      for (let i = 0; i < deps.pollAttempts && isOpen(); i++) await deps.sleep(deps.pollIntervalMs);
      if (isOpen()) {
        killWindow(deps.run, entry.tmuxSession, entry.tmuxWindow);
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
