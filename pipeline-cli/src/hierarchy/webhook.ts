/**
 * `cli-hierarchy webhook up|down|status|serve` (AISDLC-880): lifecycle of the local
 * GitHub webhook receiver. The secret comes from `AI_SDLC_WEBHOOK_SECRET` only; without
 * it nothing starts and dispatch stays poll-only.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { createReceiver } from '../dispatch/webhook-receiver.js';
import { DEFAULT_WEBHOOK_PORT, loadPrLifecycleConfig } from './pr-lifecycle-config.js';
import { eventEntries } from './pr-snapshot.js';
import type { HierarchyDeps } from './types.js';
import {
  ForwarderPersistError,
  forwarderAgentAlive,
  forwarderLabel,
  forwarderPersistence,
  installForwarder,
  removeForwarder,
} from './webhook-forwarder.js';

export const WEBHOOK_SECRET_ENV = 'AI_SDLC_WEBHOOK_SECRET';
export const WEBHOOK_PORT_ENV = 'AI_SDLC_WEBHOOK_PORT';
export { DEFAULT_WEBHOOK_PORT };
const STATE_FILE = 'webhook.json';

/** What `status` reports about the receiver. */
export type WebhookStatus =
  | { state: 'up'; port: number; pid: number }
  | { state: 'off'; reason: 'no secret' | 'not running' | 'port collision'; detail?: string };

/** What feeds the receiver: `gh webhook forward`, a tunnel, or nothing known (AISDLC-1157). */
export interface WebhookFeed {
  kind: 'gh-forward' | 'tunnel' | 'none';
  pid?: number;
  /** launchd label supervising the feed (AISDLC-1207); liveness comes from it, not a pid. */
  agent?: string;
}

const FEED_KINDS: readonly string[] = ['gh-forward', 'tunnel', 'none'];

interface WebhookState {
  pid: number;
  port: number;
  feed?: WebhookFeed;
}

/** Parse `--feed <kind>` (and `--feed-pid`); throws on an unknown kind. */
export function parseFeed(
  kind: string | undefined,
  pid?: string,
  agent?: string,
): WebhookFeed | undefined {
  if (kind === undefined) return undefined;
  if (!FEED_KINDS.includes(kind)) {
    throw new Error(`invalid webhook feed '${kind}' (gh-forward, tunnel or none)`);
  }
  const n = pid === undefined ? NaN : Number(pid);
  return {
    kind: kind as WebhookFeed['kind'],
    ...(Number.isInteger(n) && n > 0 ? { pid: n } : {}),
    ...(agent ? { agent } : {}),
  };
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const stateFile = (boardDir: string): string => path.join(boardDir, STATE_FILE);

export function readState(boardDir: string): WebhookState | undefined {
  try {
    const s = JSON.parse(readFileSync(stateFile(boardDir), 'utf-8')) as Partial<WebhookState>;
    return typeof s.pid === 'number' && typeof s.port === 'number'
      ? {
          pid: s.pid,
          port: s.port,
          ...(s.feed && FEED_KINDS.includes(s.feed.kind) ? { feed: s.feed } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a live receiver is recorded, and whether a secret is set. */
export function webhookStatus(deps: HierarchyDeps): WebhookStatus {
  if (!deps.env[WEBHOOK_SECRET_ENV]) return { state: 'off', reason: 'no secret' };
  const s = readState(deps.boardDir);
  if (s && (deps.isAlive ?? defaultIsAlive)(s.pid))
    return { state: 'up', port: s.port, pid: s.pid };
  const collision = readCollision(deps.boardDir);
  if (collision) return { state: 'off', reason: 'port collision', detail: collision };
  return { state: 'off', reason: 'not running' };
}

/** The URL the forwarder must target for a receiver on `port`. */
export const webhookTargetUrl = (port: number): string =>
  `http://127.0.0.1:${port}/webhooks/github`;

const PORT_FILE = 'webhook-port';
const COLLISION_FILE = 'webhook-collision.txt';
/** Candidate ports tried from the recorded or default port when none is pinned. */
export const WEBHOOK_PORT_SCAN = 20;

function readRecordedPort(boardDir: string): number | undefined {
  try {
    const n = Number(readFileSync(path.join(boardDir, PORT_FILE), 'utf-8').trim());
    if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
  } catch {
    /* none recorded */
  }
  return readState(boardDir)?.port;
}

function readCollision(boardDir: string): string | undefined {
  try {
    return readFileSync(path.join(boardDir, COLLISION_FILE), 'utf-8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function recordCollision(boardDir: string, message: string): void {
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(path.join(boardDir, COLLISION_FILE), message + '\n');
}

/** Whether 127.0.0.1:<port> can be bound; an unusable probe counts as free. */
function defaultPortFree(deps: HierarchyDeps, port: number): boolean {
  const script =
    `const s=require('net').createServer();` +
    `s.on('error',()=>process.exit(7));` +
    `s.listen(${port},'127.0.0.1',()=>s.close(()=>process.exit(0)))`;
  try {
    return deps.run(process.execPath, ['-e', script], { cwd: deps.cwd })?.status !== 7;
  } catch {
    return true;
  }
}

/** Best-effort `<command> (pid N)` of the listener on `port`. */
function portOwner(deps: HierarchyDeps, port: number): string {
  try {
    const r = deps.run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { cwd: deps.cwd });
    const out = (r?.stdout ?? '').split('\n');
    const pid = out.find((l) => l.startsWith('p'))?.slice(1);
    const cmd = out.find((l) => l.startsWith('c'))?.slice(1);
    if (pid) return `${cmd ?? 'unknown process'} (pid ${pid})`;
  } catch {
    /* lsof missing */
  }
  return 'an unknown process';
}

/**
 * Choose the receiver port. A pinned port (flag or env) wins and must be free. Otherwise the
 * recorded port is reused, else the configured default, scanning upward to the first free one.
 * All candidates held: throws naming the first port and its owner, and records the collision.
 */
function selectPort(deps: HierarchyDeps, flag: string | undefined): number {
  const free = deps.isPortFree ?? ((p: number) => defaultPortFree(deps, p));
  const fail = (first: number, text: string): never => {
    const message = `${text}: port ${first} is held by ${portOwner(deps, first)}`;
    recordCollision(deps.boardDir, message);
    throw new Error(message);
  };
  const raw = flag ?? deps.env[WEBHOOK_PORT_ENV];
  if (raw !== undefined && raw !== '') {
    const pinned = resolvePort(deps, flag);
    return free(pinned) || pinned === 0 ? pinned : fail(pinned, `cannot bind pinned webhook port`);
  }
  const start = readRecordedPort(deps.boardDir) ?? loadPrLifecycleConfig(deps.cwd).webhook.port;
  for (let p = start; p < start + WEBHOOK_PORT_SCAN && p <= 65535; p += 1) {
    if (free(p)) {
      mkdirSync(deps.boardDir, { recursive: true });
      writeFileSync(path.join(deps.boardDir, PORT_FILE), `${p}\n`);
      rmSync(path.join(deps.boardDir, COLLISION_FILE), { force: true });
      return p;
    }
  }
  return fail(start, `no free webhook port in ${start}-${start + WEBHOOK_PORT_SCAN - 1}`);
}

/** Health class of the webhook path (AISDLC-1157). */
export type WebhookClass = 'healthy' | 'degraded' | 'down';

/** The five signals the class is computed from. */
export interface WebhookSignals {
  receiver: boolean;
  /** Whether 127.0.0.1:<port> answered; null when not probed. */
  port: boolean | null;
  /** Minutes since the newest event file; null when there is none. */
  lastEventAgeMin: number | null;
  /** A PR changed head or state within `staleAfterMinutes` and no event names it. */
  prActivityWithoutEvent: boolean;
  /** A PR changed within `staleAfterMinutes`. */
  prActivity: boolean;
  /** No PR activity in the window: silence is expected. */
  quiet: boolean;
  forwarder: 'alive' | 'dead' | 'none' | 'unknown';
  feed: WebhookFeed['kind'];
  /** Hook delivery status from GitHub, when one `gh api` call reached it. */
  hookDelivery?: 'ok' | 'failing';
}

export interface WebhookHealth {
  class: WebhookClass;
  signals: WebhookSignals;
  /** When this reading was taken; the tick keeps the episode start. */
  since: string;
  /** One line per cause. */
  reasons: string[];
}

/** Where PR changes are tracked between ticks. */
const PR_ACTIVITY_FILE = 'webhook-pr-activity.json';

interface PrActivityState {
  heads: Record<string, { head: string; changedAt: string }>;
}

function readActivity(boardDir: string): PrActivityState {
  try {
    const s = JSON.parse(readFileSync(path.join(boardDir, PR_ACTIVITY_FILE), 'utf-8'));
    return s && typeof s.heads === 'object' ? (s as PrActivityState) : { heads: {} };
  } catch {
    return { heads: {} };
  }
}

/**
 * Fold the PR snapshot into the activity state: a new head or a new PR is a change stamped `now`. Called once per tick; never throws.
 */
export function trackPrActivity(boardDir: string, now: Date): void {
  try {
    const snap = JSON.parse(readFileSync(path.join(boardDir, 'pr-snapshot.json'), 'utf-8')) as {
      prs?: { number?: number; headRefOid?: string }[];
    };
    const prev = readActivity(boardDir);
    const next: PrActivityState = { heads: {} };
    const iso = now.toISOString();
    for (const pr of snap.prs ?? []) {
      if (typeof pr.number !== 'number') continue;
      const key = String(pr.number);
      const head = String(pr.headRefOid ?? '');
      const old = prev.heads[key];
      next.heads[key] = old && old.head === head ? old : { head, changedAt: iso };
    }
    writeFileSync(path.join(boardDir, PR_ACTIVITY_FILE), JSON.stringify(next) + '\n');
  } catch {
    /* no snapshot yet, or unreadable: no activity is recorded */
  }
}

export interface WebhookHealthOptions {
  /** Override the thresholds (defaults from `.ai-sdlc/pr-lifecycle.yaml`). */
  staleAfterMinutes?: number;
  downAfterMinutes?: number;
  /** Answers whether the port accepts a connection; default probes with a short-lived node process. */
  probePort?: (port: number) => boolean;
}

/** Synchronous TCP probe of 127.0.0.1:<port> through `deps.run`. */
function defaultProbePort(deps: HierarchyDeps, port: number): boolean {
  const script =
    `const s=require('net').connect(${port},'127.0.0.1');` +
    `s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));` +
    `setTimeout(()=>process.exit(1),1000)`;
  try {
    return deps.run(process.execPath, ['-e', script], { cwd: deps.cwd })?.status === 0;
  } catch {
    return false;
  }
}

function forwarderSignal(
  deps: HierarchyDeps,
  feed: WebhookFeed | undefined,
): WebhookSignals['forwarder'] {
  const alive = deps.isAlive ?? defaultIsAlive;
  if (feed?.kind === 'none') return 'none';
  if (feed?.agent) return forwarderAgentAlive(deps, feed.agent) ? 'alive' : 'dead';
  if (feed?.pid !== undefined) return alive(feed.pid) ? 'alive' : 'dead';
  try {
    const r = deps.run('pgrep', ['-f', feed?.kind === 'tunnel' ? 'tunnel' : 'gh webhook forward'], {
      cwd: deps.cwd,
    });
    if (r?.status === 0 && (r.stdout ?? '').trim() !== '') return 'alive';
  } catch {
    /* pgrep missing */
  }
  // A recorded feed with no pid and no process match is gone; with no record we do not know.
  return feed ? 'dead' : 'unknown';
}

/**
 * The health of the webhook path (AISDLC-1157): healthy, degraded or down from the receiver
 * pid, the port, the newest event's age, PR activity without an event, and the forwarder.
 * `healthy` with `quiet` means no PR changed in the window, so silence is expected.
 */
export function webhookHealth(deps: HierarchyDeps, opts: WebhookHealthOptions = {}): WebhookHealth {
  const cfg = loadPrLifecycleConfig(deps.cwd).webhook;
  const staleMin = opts.staleAfterMinutes ?? cfg.staleAfterMinutes;
  const downMin = opts.downAfterMinutes ?? cfg.downAfterMinutes;
  const nowMs = deps.now().getTime();
  const state = readState(deps.boardDir);
  const receiver = !!state && (deps.isAlive ?? defaultIsAlive)(state.pid);
  const port =
    receiver && state ? (opts.probePort ?? ((p) => defaultProbePort(deps, p)))(state.port) : false;

  const events = existsSync(path.join(deps.boardDir, 'events')) ? eventEntries(deps.boardDir) : [];
  const newest = events.reduce((m, e) => Math.max(m, e.mtimeMs), 0);
  const ageMin = newest > 0 ? Math.max(0, Math.floor((nowMs - newest) / 60_000)) : null;

  const activity = readActivity(deps.boardDir);
  const changes = Object.entries(activity.heads).map(([n, h]) => ({
    pr: Number(n),
    at: Date.parse(h.changedAt),
  }));
  const within = (min: number) => changes.filter((c) => nowMs - c.at <= min * 60_000);
  const recent = within(staleMin);
  const withoutEvent = recent.some(
    (c) => !events.some((e) => e.pr === c.pr && e.mtimeMs >= c.at - 60_000),
  );
  const silent = (min: number) => ageMin === null || ageMin >= min;

  const forwarder = receiver ? forwarderSignal(deps, state?.feed) : 'unknown';
  const signals: WebhookSignals = {
    receiver,
    port: receiver ? port : false,
    lastEventAgeMin: ageMin,
    prActivityWithoutEvent: withoutEvent,
    prActivity: recent.length > 0,
    quiet: recent.length === 0,
    forwarder,
    feed: state?.feed?.kind ?? (forwarder === 'alive' ? 'gh-forward' : 'none'),
  };

  const reasons: string[] = [];
  let cls: WebhookClass = 'healthy';
  if (!receiver) {
    cls = 'down';
    reasons.push('receiver process is not running');
  } else if (!port) {
    cls = 'down';
    reasons.push(`port ${state?.port} does not answer on 127.0.0.1`);
  } else if (silent(downMin) && within(downMin).length > 0) {
    cls = 'down';
    reasons.push(
      `no event for ${ageMin === null ? 'ever' : `${ageMin} min`} while a PR changed in the last ${downMin} min`,
    );
  } else if (silent(staleMin) && recent.length > 0) {
    cls = 'degraded';
    reasons.push(
      `no event for ${ageMin === null ? 'ever' : `${ageMin} min`} while a PR changed in the last ${staleMin} min`,
    );
  }
  if (cls === 'healthy' && forwarder === 'dead') {
    cls = 'degraded';
    reasons.push('the forwarder process is gone while the receiver is up');
  }
  return { class: cls, signals, since: deps.now().toISOString(), reasons };
}

/** `5m`, `3h` or `2d`; `never` for no event. */
function ageText(min: number | null): string {
  if (min === null) return 'never';
  if (min < 60) return `${min}m`;
  return min < 1440 ? `${Math.floor(min / 60)}h` : `${Math.floor(min / 1440)}d`;
}

/**
 * The status line. With a health reading: `webhook: <class> (port N, last event <age>, feed <kind>)`;
 * the bare `up` wording only says the pid answers, so it is no longer printed.
 */
export function formatWebhookStatus(w: WebhookStatus, health?: WebhookHealth): string {
  if (w.state !== 'up') {
    if (w.reason === 'port collision') return `webhook: collision (${w.detail ?? 'port held'})`;
    return health && health.class === 'down' && health.signals.receiver === false
      ? `webhook: down (${health.reasons[0] ?? w.reason})`
      : `webhook: off (${w.reason})`;
  }
  const h = health;
  return h
    ? `webhook: ${h.class} (port ${w.port}, last event ${ageText(h.signals.lastEventAgeMin)}, feed ${h.signals.feed}, target ${webhookTargetUrl(w.port)})`
    : `webhook: running (port ${w.port}, target ${webhookTargetUrl(w.port)}, health not read)`;
}

/** The `persisted:` status line (AISDLC-1256). */
export function webhookPersistence(
  deps: HierarchyDeps,
  platform: NodeJS.Platform = process.platform,
): string {
  return forwarderPersistence(deps, readState(deps.boardDir)?.feed?.agent, platform);
}

function resolvePort(deps: HierarchyDeps, flag: string | undefined): number {
  const raw = flag ?? deps.env[WEBHOOK_PORT_ENV];
  if (raw === undefined || raw === '') return loadPrLifecycleConfig(deps.cwd).webhook.port;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`invalid webhook port '${raw}'`);
  return n;
}

export type Spawner = (file: string, args: readonly string[]) => void;

const spawnDetached: Spawner = (file, args) => {
  spawn(file, [...args], { detached: true, stdio: 'ignore' }).unref();
};

/** Start the receiver in a detached process. No secret: a no-op (poll-only mode). */
export function webhookUp(
  deps: HierarchyDeps,
  portFlag?: string,
  spawner: Spawner = spawnDetached,
  feed?: WebhookFeed,
  platform: NodeJS.Platform = process.platform,
): WebhookStatus {
  const before = webhookStatus(deps);
  let chosen: number | undefined;
  let persistError: ForwarderPersistError | undefined;
  if (feed?.kind === 'gh-forward' && feed.pid === undefined) {
    const secret = deps.env[WEBHOOK_SECRET_ENV];
    if (!secret) throw new Error(`${WEBHOOK_SECRET_ENV} is not set: cannot start the forwarder`);
    const fwdPort = before.state === 'up' ? before.port : selectPort(deps, portFlag);
    if (before.state !== 'up') chosen = fwdPort;
    try {
      const supervised = installForwarder(deps, secret, fwdPort, platform);
      feed = supervised ? { kind: 'gh-forward', agent: forwarderLabel(deps) } : feed;
    } catch (e) {
      if (!(e instanceof ForwarderPersistError)) throw e;
      // The receiver still starts (foreground session only); the command then exits non-zero.
      persistError = e;
    }
  }
  if (before.state === 'up') {
    if (feed) recordFeed(deps.boardDir, feed);
    deps.log(`webhook already running on 127.0.0.1:${before.port}`);
    if (persistError) throw persistError;
    return before;
  }
  if (before.reason === 'no secret') {
    deps.log(`webhook off: ${WEBHOOK_SECRET_ENV} is not set (poll-only mode)`);
    return before;
  }
  const port = chosen ?? selectPort(deps, portFlag);
  spawner(process.execPath, [
    deps.binPath ?? process.argv[1] ?? '',
    'webhook',
    'serve',
    '--port',
    String(port),
    '--board-dir',
    deps.boardDir,
    ...(feed
      ? [
          '--feed',
          feed.kind,
          ...(feed.pid ? ['--feed-pid', String(feed.pid)] : []),
          ...(feed.agent ? ['--feed-agent', feed.agent] : []),
        ]
      : []),
  ]);
  deps.log(`webhook starting on 127.0.0.1:${port}`);
  if (persistError) throw persistError;
  return before;
}

/** Rewrite the recorded feed of a running receiver. */
function recordFeed(boardDir: string, feed: WebhookFeed): void {
  const s = readState(boardDir);
  if (s) writeFileSync(stateFile(boardDir), JSON.stringify({ ...s, feed }) + '\n');
}

/** Stop a recorded receiver. */
export function webhookDown(
  deps: HierarchyDeps,
  kill: (pid: number) => void = (pid) => process.kill(pid, 'SIGTERM'),
): boolean {
  const s = readState(deps.boardDir);
  if (s?.feed?.agent) removeForwarder(deps, s.feed.agent);
  if (!s) {
    deps.log('webhook not running');
    return false;
  }
  if ((deps.isAlive ?? defaultIsAlive)(s.pid)) kill(s.pid);
  rmSync(stateFile(deps.boardDir), { force: true });
  deps.log(`webhook stopped (port ${s.port})`);
  return true;
}

/** Run the receiver in the foreground until SIGTERM or SIGINT. Needs the secret. */
export async function webhookServe(
  deps: HierarchyDeps,
  portFlag?: string,
  feed?: WebhookFeed,
): Promise<void> {
  const secret = deps.env[WEBHOOK_SECRET_ENV];
  if (!secret) throw new Error(`${WEBHOOK_SECRET_ENV} is not set`);
  const receiver = createReceiver({
    secret,
    boardDir: deps.boardDir,
    port: resolvePort(deps, portFlag),
    debounceMs: loadPrLifecycleConfig(deps.cwd).webhook.debounceMs,
  });
  try {
    await receiver.start();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      const port = resolvePort(deps, portFlag);
      const message = `cannot bind webhook port: port ${port} is held by ${portOwner(deps, port)}`;
      recordCollision(deps.boardDir, message);
      throw new Error(message, { cause: e });
    }
    throw e;
  }
  rmSync(path.join(deps.boardDir, COLLISION_FILE), { force: true });
  mkdirSync(deps.boardDir, { recursive: true });
  writeFileSync(
    stateFile(deps.boardDir),
    JSON.stringify({ pid: process.pid, port: receiver.port, ...(feed ? { feed } : {}) }) + '\n',
  );
  deps.log(`webhook listening on 127.0.0.1:${receiver.port}`);
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  await receiver.stop();
  rmSync(stateFile(deps.boardDir), { force: true });
}
