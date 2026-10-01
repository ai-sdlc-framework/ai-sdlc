/**
 * `cli-hierarchy down`: end sessions cleanly, return their inflight manifests
 * to the queue, close their windows and drop them from the roster.
 */

import { releaseInflight } from '../dispatch/board.js';
import { listInflight } from './inflight.js';
import { readRosterChecked, writeRoster } from './roster.js';
import { killWindow, listWindows, resolveSendTarget, sendExit } from './tmux.js';
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
  for (const entry of selected) {
    const isOpen = () => listWindows(deps.run, entry.tmuxSession).includes(entry.tmuxWindow);
    let forced = false;
    if (isOpen()) {
      sendExit(
        deps.run,
        resolveSendTarget(deps.run, entry.tmuxSession, entry.tmuxWindow, entry.paneId),
      );
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
  return { stopped };
}
