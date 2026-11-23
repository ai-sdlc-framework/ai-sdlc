/**
 * Deliver one line to the running planner session (AISDLC-1190).
 *
 * Reconcile's `route-to-planner` decisions, a red main and new escalation files used to be recorded
 * on the board and printed to a log nobody reads. This is the one sender they share: it finds the
 * planner in the roster and types the line through the same guarded path as `cli-hierarchy send`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { createTmuxBriefSender, type BriefSender } from './brief-notify.js';
import { readRosterChecked } from './roster.js';
import { paneScreenAt, resolveSendTarget } from './tmux.js';
import { readReceivedAddresses, sendToRoster, type SocketSender } from './send.js';
import type { CommandRunner } from './types.js';

/**
 * True when the composer line of a captured pane holds typed text. The composer is the last prompt
 * line (`❯ ...`, optionally inside a box border); a bare prompt is empty.
 */
export function composerHasText(tail: string): boolean {
  const lines = tail
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    const m = /^[│|]?\s*[❯>](?:\s+(.*?))?\s*[│|]?$/u.exec(lines[i] ?? '');
    if (m) return (m[1] ?? '').trim() !== '';
  }
  return false;
}

/**
 * The socket address the planner recorded for itself in `<board>/handoff/address-<name>.json`
 * (a JSON string `uds:/...sock`), or undefined when none is recorded.
 */
export function readPlannerAddress(boardDir: string, name: string): string | undefined {
  try {
    const v: unknown = JSON.parse(
      fs.readFileSync(path.join(boardDir, 'handoff', `address-${name}.json`), 'utf8'),
    );
    return typeof v === 'string' && v.startsWith('uds:') ? v : undefined;
  } catch {
    return undefined;
  }
}

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
    const address = readPlannerAddress(boardDir, planner.name);
    if (address) {
      // A recorded address never touches the pane, so it cannot collide with the operator's typing.
      sendToRoster(roster.sessions, address, text, noPane, [address], sendSocket);
      return;
    }
    const tmuxSend = send ?? createTmuxBriefSender(run);
    const guarded: BriefSender = (entry, message) => {
      const target = resolveSendTarget(run, entry.tmuxSession, entry.tmuxWindow, entry.paneId);
      if (composerHasText(paneScreenAt(run, target))) {
        throw new Error(
          `the planner composer holds unsent text; notice held back and retried on a later pass`,
        );
      }
      tmuxSend(entry, message);
    };
    sendToRoster(
      roster.sessions,
      planner.name,
      text,
      guarded,
      readReceivedAddresses(boardDir),
      sendSocket,
    );
  };
}

const noPane: BriefSender = () => {
  throw new Error('a planner notice with a recorded address never types into the pane');
};
