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

import { checkSendTarget, SOCKET_ADDRESS, type ReceivedSender } from './send.js';
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

export interface ResolvedTarget {
  /** What the caller named. */
  to: string;
  /** The live socket of the session, when one resolved; an address for `SendMessage`, never written to here. */
  address?: string;
  /** Set when the named address was stale and the session's current socket was found. */
  repaired?: { name: string; from: string; to: string };
}

/**
 * Why `cli-hierarchy send` delivers nothing (AISDLC-1464, DEC-0455 a). The harness publishes no socket wire
 * format: a raw line written to a session socket was dropped while the CLI printed ok, and a pane-typed line
 * reaches the model as operator input. The CLI therefore never writes to a socket and never types into a pane;
 * it names the target and the two channels that deliver.
 */
export function noDeliveryPathMessage(target: ResolvedTarget): string {
  const where = target.address ? ` (live socket ${target.address})` : '';
  return (
    `no delivery path from this CLI to '${target.to}'${where}: the harness publishes no socket wire format, so ` +
    'cli-hierarchy send never writes to a session socket and never types into a pane. Nothing was sent. ' +
    'Deliver it with the SendMessage tool from a model session, or with $.session.send from a hooks module.'
  );
}

/**
 * Resolve the target of `cli-hierarchy send` (AISDLC-1036, AISDLC-1080, AISDLC-1392) without sending: a roster
 * name, a received `uds:` address whose socket exists or whose sender name re-resolves, or a sender name in the
 * received log resolved through the registry. Throws the refusal reason; a dead received address throws
 * {@link DeadAddressError} so the caller can prune it.
 */
export function resolveDeliveryTarget(opts: {
  sessions: readonly RosterEntry[];
  to: string;
  text: string;
  received: readonly ReceivedSender[];
  registry: readonly RegistrySession[];
  deps?: ResolveDeps;
}): ResolvedTarget {
  const { sessions, to, text, received, registry } = opts;
  const deps = opts.deps ?? defaultResolveDeps;
  if (/[\r\n]/.test(text)) {
    throw new Error('refusing to send: the text contains a newline');
  }
  if (SOCKET_ADDRESS.test(to)) {
    const known = received.find((r) => r.address === to);
    if (!known) {
      const check = checkSendTarget(sessions, to, []);
      throw new Error(check.ok ? `refusing to send to '${to}'` : check.reason);
    }
    if (deps.socketExists(to)) return { to, address: to };
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
    return { to, address: current, repaired: { name: known.name, from: to, to: current } };
  }
  const check = checkSendTarget(sessions, to, []);
  if (check.ok && 'entry' in check) {
    const address = resolveSessionSocket(registry, to, deps);
    return address ? { to, address } : { to };
  }
  if (!received.some((r) => r.name === to)) {
    throw new Error(check.ok ? `refusing to send to '${to}'` : check.reason);
  }
  const address = resolveSessionSocket(registry, to, deps);
  if (!address) {
    throw new Error(`refusing to send to '${to}': it does not resolve to a live session socket`);
  }
  return { to, address };
}
