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
export type SocketSender = (address: string, message: string) => void | Promise<void>;

/** A `from` address a received message carried, with the sender's session name when it sent one. */
export interface ReceivedSender {
  address: string;
  name?: string;
}

export const SOCKET_ADDRESS = /^uds:\/[A-Za-z0-9._/-]+\.sock$/;

/**
 * AISDLC-1080: the `from` addresses the hooks module recorded for received cross-session messages, in
 * `<board-dir>/handoff/received-<session>.json` (a JSON array written by `session.receive`). AISDLC-1392:
 * an element is `{address, name}`; a bare string (the older shape) is an address with no name.
 */
export function readReceivedSenders(boardDir: string): ReceivedSender[] {
  const out = new Map<string, ReceivedSender>();
  for (const f of receivedFiles(boardDir)) {
    for (const s of readReceivedFile(f)) if (!out.has(s.address)) out.set(s.address, s);
  }
  return [...out.values()];
}

export function readReceivedAddresses(boardDir: string): string[] {
  return readReceivedSenders(boardDir).map((s) => s.address);
}

function receivedFiles(boardDir: string): string[] {
  const dir = path.join(boardDir, 'handoff');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^received-.+\.json$/.test(f))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function readReceivedFile(file: string): ReceivedSender[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    const out: ReceivedSender[] = [];
    for (const a of parsed) {
      if (typeof a === 'string') out.push({ address: a });
      else if (a && typeof a === 'object' && typeof (a as ReceivedSender).address === 'string') {
        const { address, name } = a as ReceivedSender;
        out.push(typeof name === 'string' && name ? { address, name } : { address });
      }
    }
    return out;
  } catch {
    return []; // an unreadable log contributes no address
  }
}

/**
 * AISDLC-1392: drop `address` from the received logs once a send found its socket gone and its sender name
 * no longer resolving, so the dead address stops being accepted. Only that address is touched, and only after
 * such a failed send, so a successful send never rewrites the logs. Returns how many entries were dropped.
 */
export function pruneReceivedLog(boardDir: string, address: string): number {
  let dropped = 0;
  for (const f of receivedFiles(boardDir)) {
    const all = readReceivedFile(f);
    const kept = all.filter((s) => s.address !== address);
    if (kept.length === all.length) continue;
    dropped += all.length - kept.length;
    try {
      fs.writeFileSync(f, JSON.stringify(kept));
    } catch {
      // a log we cannot rewrite stays as it was
    }
  }
  return dropped;
}

/**
 * Default delivery to a socket address: one line written to the unix socket. Rejects when the socket is
 * gone (ENOENT) or nothing listens on it (ECONNREFUSED), so a lost message is never reported as sent.
 */
export const createSocketSender: SocketSender = (address, message) =>
  new Promise<void>((resolve, reject) => {
    const client = net.connect(address.slice('uds:'.length));
    client.once('error', reject);
    client.once('connect', () => client.end(`${message}\n`, () => resolve()));
  });

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
): void | Promise<void> {
  if (/[\r\n]/.test(text)) {
    throw new Error(
      'refusing to send: the text contains a newline (a pane would run it as separate input)',
    );
  }
  const check = checkSendTarget(sessions, to, received);
  if (!check.ok) throw new Error(check.reason);
  if ('address' in check) return sendSocket(check.address, text);
  send(check.entry, text);
}
