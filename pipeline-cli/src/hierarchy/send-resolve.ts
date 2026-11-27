/**
 * Name-to-current-socket lookup for `cli-hierarchy send` (AISDLC-1392).
 *
 * A Claude Code session listens on `/tmp/cc-socks/<pid>.sock`; a relaunch gives it a new pid, so the address
 * a peer once sent from goes stale. The session registry (`~/.claude/sessions/*.json`) maps the session name
 * to its current pid and socket, so a stale address or a bare name is re-resolved there, or the send fails
 * loudly with the reason. A pid reused by another process is told apart by the entry's `procStart`.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import type { BriefSender } from './brief-notify.js';
import { checkSendTarget, SOCKET_ADDRESS, type ReceivedSender, type SocketSender } from './send.js';
import type { RegistrySession, RosterEntry } from './types.js';

/** Where Claude Code sessions listen: `/tmp/cc-socks/<pid>.sock`. */
export const SESSION_SOCKET_DIR = '/tmp/cc-socks';

export function sessionSocketAddress(pid: number): string {
  return `uds:${SESSION_SOCKET_DIR}/${pid}.sock`;
}

/** True when the unix socket behind a `uds:` address exists on disk. */
export function socketPathExists(address: string): boolean {
  return fs.existsSync(address.slice('uds:'.length));
}

/**
 * The start time of a process as `ps` prints it in UTC (the zone the harness records `procStart` in),
 * whitespace collapsed; undefined when it is not running.
 */
export function processStartOf(pid: number): string | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.replace(/\s+/g, ' ').trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface ResolveDeps {
  procStartOf: (pid: number) => string | undefined;
  socketExists: (address: string) => boolean;
}

export const defaultResolveDeps: ResolveDeps = {
  procStartOf: processStartOf,
  socketExists: socketPathExists,
};

/**
 * The live socket address of the session called `name`: the newest registry entry of that name whose pid
 * still runs the process that was registered (same start time) and whose socket exists. The socket is the
 * entry's `messagingSocketPath`, else derived from its pid.
 */
export function resolveSessionSocket(
  registry: readonly RegistrySession[],
  name: string,
  deps: ResolveDeps = defaultResolveDeps,
): string | undefined {
  const candidates = registry
    .filter((s) => s.name === name)
    .sort((a, b) => b.startedAt - a.startedAt);
  for (const s of candidates) {
    const running = deps.procStartOf(s.pid);
    if (running === undefined) continue;
    if (s.procStart && s.procStart.replace(/\s+/g, ' ').trim() !== running) continue;
    const address = s.messagingSocketPath
      ? `uds:${s.messagingSocketPath}`
      : sessionSocketAddress(s.pid);
    if (SOCKET_ADDRESS.test(address) && deps.socketExists(address)) return address;
  }
  return undefined;
}

/** A refusal whose received address is dead: its sender name no longer resolves to a live session. */
export class DeadAddressError extends Error {
  constructor(
    message: string,
    readonly deadAddress: string,
  ) {
    super(message);
  }
}

export interface SendOutcome {
  /** What the caller named. */
  sent: string;
  /** Set when the named address was stale and the message went to the session's current socket. */
  repaired?: { name: string; from: string; to: string };
  /** Set when a name resolved to a socket through the registry. */
  via?: string;
}

/**
 * Send one message for `cli-hierarchy send`. A roster name types into its pane as before; a received `uds:`
 * address is used when its socket exists and otherwise re-resolved by the sender's recorded name; any other
 * name must be a sender in the received log and is resolved through the registry. Throws the refusal
 * reason, and rejects when the socket cannot be written.
 */
export async function sendResolved(opts: {
  sessions: readonly RosterEntry[];
  to: string;
  text: string;
  received: readonly ReceivedSender[];
  registry: readonly RegistrySession[];
  sendPane: BriefSender;
  sendSocket: SocketSender;
  deps?: ResolveDeps;
}): Promise<SendOutcome> {
  const { sessions, to, text, received, registry, sendPane, sendSocket } = opts;
  const deps = opts.deps ?? defaultResolveDeps;
  if (/[\r\n]/.test(text)) {
    throw new Error(
      'refusing to send: the text contains a newline (a pane would run it as separate input)',
    );
  }
  if (SOCKET_ADDRESS.test(to)) {
    const known = received.find((r) => r.address === to);
    if (!known) {
      const check = checkSendTarget(sessions, to, []);
      throw new Error(check.ok ? `refusing to send to '${to}'` : check.reason);
    }
    if (deps.socketExists(to)) {
      await sendSocket(to, text);
      return { sent: to };
    }
    if (!known.name) {
      throw new Error(
        `refusing to send to '${to}': its socket is gone and no sender name was recorded to find the new one`,
      );
    }
    const current = resolveSessionSocket(registry, known.name, deps);
    if (!current) {
      throw new DeadAddressError(
        `refusing to send to '${to}': its socket is gone and '${known.name}' no longer resolves to a live session`,
        to,
      );
    }
    await sendSocket(current, text);
    return { sent: to, repaired: { name: known.name, from: to, to: current } };
  }
  const check = checkSendTarget(sessions, to, []);
  if (check.ok && 'entry' in check) {
    sendPane(check.entry, text);
    return { sent: to };
  }
  if (!received.some((r) => r.name === to)) {
    throw new Error(check.ok ? `refusing to send to '${to}'` : check.reason);
  }
  const address = resolveSessionSocket(registry, to, deps);
  if (!address) {
    throw new Error(`refusing to send to '${to}': it does not resolve to a live session socket`);
  }
  await sendSocket(address, text);
  return { sent: to, via: address };
}
