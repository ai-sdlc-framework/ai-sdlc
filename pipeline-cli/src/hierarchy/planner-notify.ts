/**
 * Deliver one line to the running planner session (AISDLC-1190).
 *
 * Reconcile's `route-to-planner` decisions, a red main and new escalation files used to be recorded
 * on the board and printed to a log nobody reads. This is the one sender they share: it finds the
 * planner in the roster and types the line through the same guarded path as `cli-hierarchy send`.
 */

import { createTmuxBriefSender, type BriefSender } from './brief-notify.js';
import { readRosterChecked } from './roster.js';
import { readReceivedAddresses, sendToRoster, type SocketSender } from './send.js';
import type { CommandRunner } from './types.js';

/** Sends one line to the planner; throws when it cannot be delivered, so callers keep the item undelivered. */
export type PlannerNotifier = (text: string) => void;

export function createPlannerNotifier(
  boardDir: string,
  run: CommandRunner,
  send?: BriefSender,
  sendSocket?: SocketSender,
): PlannerNotifier {
  return (text) => {
    const { roster } = readRosterChecked(boardDir);
    const planner = roster.sessions.find((e) => e.role === 'planner' && e.status === 'running');
    if (!planner) throw new Error('no running planner session in the roster');
    sendToRoster(
      roster.sessions,
      planner.name,
      text,
      send ?? createTmuxBriefSender(run),
      readReceivedAddresses(boardDir),
      sendSocket,
    );
  };
}
