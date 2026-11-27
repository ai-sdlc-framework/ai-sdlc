/**
 * Deliver one line to the running planner session (AISDLC-1190).
 *
 * Reconcile's `route-to-planner` decisions, a red main and new escalation files used to be recorded
 * on the board and printed to a log nobody reads. This is the one sender they share: it finds the
 * planner in the roster and types the line through the same guarded path as `cli-hierarchy send`.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { BriefSender } from './brief-notify.js';
import { readRosterChecked } from './roster.js';
import { sendToRoster, type SocketSender } from './send.js';
import { sessionSocketAddress } from './send-resolve.js';
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

/**
 * The socket address of the running planner: the address it recorded, else the one derived from its
 * roster pid. Undefined when there is no running planner or no usable address.
 */
export function plannerSocketAddress(boardDir: string): string | undefined {
  let planner;
  try {
    planner = readRosterChecked(boardDir).roster.sessions.find(
      (e) => e.role === 'planner' && e.status === 'running',
    );
  } catch {
    return undefined;
  }
  if (!planner) return undefined;
  const recorded = readPlannerAddress(boardDir, planner.name);
  if (recorded) return recorded;
  return Number.isInteger(planner.pid) && planner.pid > 0
    ? sessionSocketAddress(planner.pid)
    : undefined;
}

/** True when the unix socket behind a `uds:` address exists on disk. */
export function socketExists(address: string): boolean {
  return fs.existsSync(address.slice('uds:'.length));
}

/**
 * Sends one line to the planner session socket; throws when it cannot be delivered, so callers keep
 * the item undelivered. It never types into the pane: that interleaves with the operator's typing.
 */
export type PlannerNotifier = (text: string) => void;

export function createPlannerNotifier(
  boardDir: string,
  _run?: CommandRunner,
  _send?: BriefSender,
  sendSocket?: SocketSender,
  exists: (address: string) => boolean = socketExists,
): PlannerNotifier {
  return (text) => {
    const { roster } = readRosterChecked(boardDir);
    const planner = roster.sessions.find((e) => e.role === 'planner' && e.status === 'running');
    if (!planner) throw new Error('no running planner session in the roster');
    const address = plannerSocketAddress(boardDir);
    if (!address) throw new Error('the planner has no recorded address and no roster pid');
    if (!exists(address)) {
      throw new Error(`the planner socket ${address} is missing; notice held back and retried`);
    }
    // The notifier is synchronous: a send that fails after the socket check is still not reported here.
    const sent = sendToRoster(roster.sessions, address, text, noPane, [address], sendSocket);
    if (sent) void sent.catch(() => undefined);
  };
}

const noPane: BriefSender = () => {
  throw new Error('a planner notice never types into the pane');
};
