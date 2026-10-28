/**
 * Roster guard for peer messages (AISDLC-1036, RFC-0058 phase 3).
 *
 * `cli-hierarchy send --to <name> --text <message>` is the one way a session messages a peer by hand:
 * it refuses a `to` that is not listed in this project's roster (`<board-dir>/hierarchy.json`, the same
 * source `cli-hierarchy status` prints) nor the `from` address of a message this session received, and says so, so a look-alike name from memory or from another
 * project's session on the same machine never reaches a pane. This is a mistake guard, not authentication.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { ROSTER_FILENAME } from './roster.js';
import { rosterProject } from './peer-guard.js';
import type { BriefSender } from './brief-notify.js';
import type { RosterEntry } from './types.js';

export type SendCheck =
  { ok: true; entry: RosterEntry } | { ok: true; address: string } | { ok: false; reason: string };

/** Delivers one line to the socket address of a message this session received. Injected in tests. */
export type SocketSender = (address: string, message: string) => void;

const SOCKET_ADDRESS = /^uds:\/[A-Za-z0-9._/-]+\.sock$/;

/**
 * AISDLC-1080: the `from` addresses the hooks module recorded for received cross-session messages, in
 * `<board-dir>/handoff/received-<session>.json` (a JSON array of strings, written by `session.receive`).
 */
export function readReceivedAddresses(boardDir: string): string[] {
  const dir = path.join(boardDir, 'handoff');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => /^received-.+\.json$/.test(f));
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const f of files) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (Array.isArray(parsed)) {
        for (const a of parsed) if (typeof a === 'string') out.add(a);
      }
    } catch {
      // an unreadable log contributes no address
    }
  }
  return [...out];
}

/** Default delivery to a received address: one line written to the unix socket the message came from. */
export const createSocketSender: SocketSender = (address, message) => {
  const sock = address.slice('uds:'.length);
  const client = net.connect(sock);
  client.on('error', () => undefined);
  client.end(`${message}\n`);
};

/**
 * Find `to` in the roster, or (AISDLC-1080) among the `from` addresses of messages this session received,
 * or say why it cannot be addressed. A freehand name is never accepted.
 */
export function checkSendTarget(
  sessions: readonly RosterEntry[],
  to: string,
  received: readonly string[] = [],
): SendCheck {
  if (SOCKET_ADDRESS.test(to) && received.includes(to)) return { ok: true, address: to };
  const source = `the roster (${ROSTER_FILENAME}, as printed by cli-hierarchy status)`;
  const project = rosterProject(sessions);
  if (!project.ok) return { ok: false, reason: `refusing to send to '${to}': ${project.reason}` };
  const entry = sessions.find((s) => s.name === to);
  if (!entry) {
    const names = sessions.map((s) => s.name).join(', ') || 'none';
    return {
      ok: false,
      reason: `refusing to send to '${to}': it is not listed in ${source} for project '${project.project}' (listed: ${names})`,
    };
  }
  return { ok: true, entry };
}

/** Send one message to a roster session; throws the refusal reason when `to` is not in the roster. */
export function sendToRoster(
  sessions: readonly RosterEntry[],
  to: string,
  text: string,
  send: BriefSender,
  received: readonly string[] = [],
  sendSocket: SocketSender = createSocketSender,
): void {
  if (/[\r\n]/.test(text)) {
    throw new Error(
      'refusing to send: the text contains a newline (a pane would run it as separate input)',
    );
  }
  const check = checkSendTarget(sessions, to, received);
  if (!check.ok) throw new Error(check.reason);
  if ('address' in check) sendSocket(check.address, text);
  else send(check.entry, text);
}
