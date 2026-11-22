/**
 * `cli-hierarchy webhook up|down|status|serve` (AISDLC-880): lifecycle of the local
 * GitHub webhook receiver. The secret comes from `AI_SDLC_WEBHOOK_SECRET` only; without
 * it nothing starts and dispatch stays poll-only.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { createReceiver, FOREIGN_FILE, REFUSED_FILE } from '../dispatch/webhook-receiver.js';
import { DEFAULT_WEBHOOK_PORT, loadPrLifecycleConfig } from './pr-lifecycle-config.js';
import { eventEntries } from './pr-snapshot.js';
import type { HierarchyDeps } from './types.js';
import {
  ForwarderPersistError,
  resolveRepo,
  forwarderAgentAlive,
  forwarderLabel,
  forwarderPersistence,
  installForwarder,
  LEGACY_FORWARDER_LABEL,
  removeForwarder,
  removeLegacyForwarder,
} from './webhook-forwarder.js';

export const WEBHOOK_SECRET_ENV = 'AI_SDLC_WEBHOOK_SECRET';
export const WEBHOOK_PORT_ENV = 'AI_SDLC_WEBHOOK_PORT';
export { DEFAULT_WEBHOOK_PORT };
const STATE_FILE = 'webhook.json';

/** What `status` reports about the receiver. */
export type WebhookStatus =
  | { state: 'up'; port: number; pid: number }
  | {
      state: 'off';
      reason: 'no secret' | 'not running' | 'port collision' | 'foreign listener';
      detail?: string;
    };

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
  /** `owner/repo` the receiver serves; absent when it could not be resolved. */
  repo?: string;
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
          ...(typeof s.repo === 'string' && s.repo ? { repo: s.repo } : {}),
          ...(s.feed && FEED_KINDS.includes(s.feed.kind) ? { feed: s.feed } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

export interface WebhookIdentity {
  repo: string | null;
  boardDir: string;
}

/** Ask 127.0.0.1:<port>/health who answers, through `deps.run`; undefined when nothing valid answers. */
function defaultProbeIdentity(deps: HierarchyDeps, port: number): WebhookIdentity | undefined {
  const script =
    `require('http').get({host:'127.0.0.1',port:${port},path:'/health',timeout:1000},r=>{` +
    `let b='';r.on('data',c=>b+=c);r.on('end',()=>{process.stdout.write(b);process.exit(0)})})` +
    `.on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1));` +
    `setTimeout(()=>process.exit(1),1500)`;
  try {
    const r = deps.run(process.execPath, ['-e', script], { cwd: deps.cwd });
    if (r?.status !== 0) return undefined;
    const j = JSON.parse(r.stdout ?? '') as { repo?: unknown; boardDir?: unknown };
    if (typeof j.boardDir !== 'string') return undefined;
    return { repo: typeof j.repo === 'string' ? j.repo : null, boardDir: j.boardDir };
  } catch {
    return undefined;
  }
}

/** Why the listener on `port` is not this board's receiver; undefined when it is. */
function identityProblem(
  deps: HierarchyDeps,
  port: number,
  probe?: (port: number) => WebhookIdentity | undefined,
): { reason: string; repo: string | null } | undefined {
  const id = (probe ?? deps.probeWebhookIdentity ?? ((p) => defaultProbeIdentity(deps, p)))(port);
  if (!id) return { reason: `port ${port} does not answer /health as a receiver`, repo: null };
  if (path.resolve(id.boardDir) !== path.resolve(deps.boardDir)) {
    return {
      reason: `port ${port} answers as another board's receiver (repository ${id.repo ?? 'unknown'}, board ${id.boardDir})`,
      repo: id.repo,
    };
  }
  return undefined;
}

/** Whether a live receiver of this board is recorded, and whether a secret is set. */
export function webhookStatus(deps: HierarchyDeps): WebhookStatus {
  if (!deps.env[WEBHOOK_SECRET_ENV]) return { state: 'off', reason: 'no secret' };
  const s = readState(deps.boardDir);
  if (s && (deps.isAlive ?? defaultIsAlive)(s.pid)) {
    const problem = identityProblem(deps, s.port);
    if (!problem) return { state: 'up', port: s.port, pid: s.pid };
    return { state: 'off', reason: 'foreign listener', detail: problem.reason };
  }
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

/** Whether 127.0.0.1:<port> can be bound; an unusable or failed probe counts as busy. */
function defaultPortFree(deps: HierarchyDeps, port: number): boolean {
  const script =
    `const s=require('net').createServer();` +
    `s.on('error',()=>process.exit(7));` +
    `s.listen(${port},'127.0.0.1',()=>s.close(()=>process.exit(0)))`;
  try {
    return deps.run(process.execPath, ['-e', script], { cwd: deps.cwd })?.status === 0;
  } catch {
    return false;
  }
}

/** Whether `port` can be bound now, through the injected probe when present. */
export function isWebhookPortFree(deps: HierarchyDeps, port: number): boolean {
  return (deps.isPortFree ?? ((p: number) => defaultPortFree(deps, p)))(port);
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
 * Choose the candidate receiver port; the receiver records it only once it has bound. A pinned port (flag or env) wins and must be free. Otherwise the
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
      rmSync(path.join(deps.boardDir, COLLISION_FILE), { force: true });
      return p;
    }
  }
  return fail(start, `no free webhook port in ${start}-${start + WEBHOOK_PORT_SCAN - 1}`);
}

/** Health class of the webhook path (AISDLC-1157). */
/**
 * `unverified`: the receiver is up but no event was ever delivered and nothing says it should
 * have been (AISDLC-1345). It is not `healthy`, and it neither opens nor closes a decision.
 */
export type WebhookClass = 'healthy' | 'unverified' | 'degraded' | 'down';

/** The five signals the class is computed from. */
export interface WebhookSignals {
  receiver: boolean;
  /** Whether 127.0.0.1:<port> answered; null when not probed. */
  port: boolean | null;
  /** Minutes since the newest event file; null when there is none. */
  lastEventAgeMin: number | null;
  /** When the newest event file arrived (ISO); absent when there is none. */
  lastEventAt?: string;
  /** The port the receiver recorded; absent when none is recorded. */
  receiverPort?: number;
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
  /** Deliveries refused for a bad signature since the last accepted event (AISDLC-1285). */
  refusedDeliveries?: number;
  /** Signed deliveries refused because they name another repository (AISDLC-1349). */
  foreignDeliveries?: { count: number; repo: string };
}

export interface WebhookHealth {
  class: WebhookClass;
  /** `owner/repo` this board's receiver serves; absent when unknown. */
  repo?: string;
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
  /** Answers who listens on the port (`/health`); default asks over HTTP through `deps.run`. */
  probeIdentity?: (port: number) => WebhookIdentity | undefined;
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

function readRefused(boardDir: string): { at: string; count: number } | undefined {
  try {
    const r = JSON.parse(readFileSync(path.join(boardDir, REFUSED_FILE), 'utf-8'));
    return typeof r.at === 'string' && typeof r.count === 'number' ? r : undefined;
  } catch {
    return undefined;
  }
}

function readForeign(boardDir: string): { count: number; repo: string } | undefined {
  try {
    const r = JSON.parse(readFileSync(path.join(boardDir, FOREIGN_FILE), 'utf-8'));
    return typeof r.repo === 'string' && typeof r.count === 'number' && r.count > 0
      ? { count: r.count, repo: r.repo }
      : undefined;
  } catch {
    return undefined;
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
  // Liveness comes only from this board's own record, never a process-name match (another
  // board's forwarder must not read as ours). A recorded feed with no pid or agent is gone.
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
  const pidAlive = !!state && (deps.isAlive ?? defaultIsAlive)(state.pid);
  const port =
    pidAlive && state ? (opts.probePort ?? ((p) => defaultProbePort(deps, p)))(state.port) : false;
  const problem =
    pidAlive && state && port ? identityProblem(deps, state.port, opts.probeIdentity) : undefined;
  const receiver = pidAlive && !problem;
  const repo = state?.repo;

  const events = (
    existsSync(path.join(deps.boardDir, 'events')) ? eventEntries(deps.boardDir) : []
  ).filter((e) => !repo || e.repo === null || e.repo.toLowerCase() === repo.toLowerCase());
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
    ...(newest > 0 ? { lastEventAt: new Date(newest).toISOString() } : {}),
    ...(state ? { receiverPort: state.port } : {}),
    ...(readForeign(deps.boardDir) ? { foreignDeliveries: readForeign(deps.boardDir) } : {}),
    prActivityWithoutEvent: withoutEvent,
    prActivity: recent.length > 0,
    quiet: recent.length === 0,
    forwarder,
    feed: state?.feed?.kind ?? 'none',
  };

  const reasons: string[] = [];
  let cls: WebhookClass = 'healthy';
  if (problem) {
    cls = 'down';
    reasons.push(problem.reason);
  } else if (!receiver) {
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
    reasons.push('the forwarder is not running while the receiver is up');
  }
  if (cls === 'healthy' && newest === 0) {
    cls = 'unverified';
    reasons.push('no event has been delivered yet, so the feed is unverified');
  }
  const refused = readRefused(deps.boardDir);
  if (refused && Date.parse(refused.at) > newest) {
    signals.refusedDeliveries = refused.count;
    if (cls === 'healthy' || cls === 'unverified') cls = 'degraded';
    reasons.push(
      `${refused.count} delivery(ies) refused for a bad signature since ${refused.at}: the forwarder secret does not match AI_SDLC_WEBHOOK_SECRET (secret mismatch)`,
    );
  }
  return {
    class: cls,
    ...(repo ? { repo } : {}),
    signals,
    since: deps.now().toISOString(),
    reasons,
  };
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
    if (w.reason === 'foreign listener') return `webhook: down (${w.detail ?? w.reason})`;
    return health && health.class === 'down' && health.signals.receiver === false
      ? `webhook: down (${health.reasons[0] ?? w.reason})`
      : `webhook: off (${w.reason})`;
  }
  const h = health;
  return h
    ? `webhook: ${h.class} (port ${w.port}, repo ${h.repo ?? 'unknown'}, last event ${ageText(h.signals.lastEventAgeMin)}, feed ${h.signals.feed}, target ${webhookTargetUrl(w.port)})`
    : `webhook: running (port ${w.port}, target ${webhookTargetUrl(w.port)}, health not read)`;
}

/** The refused-foreign-delivery line; empty when there are none (AISDLC-1349). */
export function formatWebhookForeign(health?: WebhookHealth): string[] {
  const f = health?.signals.foreignDeliveries;
  return f
    ? [
        `webhook: ${f.count} delivery(ies) refused for repository ${f.repo} (this board serves ${health?.repo ?? 'an unknown repository'}); a forwarder is posting to the wrong port`,
      ]
    : [];
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

/** The line `up` and `restart` print for a board with no recorded feed. */
export const NO_FEED_LINE =
  'webhook: no feed is installed, so this board receives no events; run `cli-hierarchy webhook up --feed gh-forward` to install one';

/** Print {@link NO_FEED_LINE} when the board's state file records no feed. */
export function logNoFeed(deps: HierarchyDeps): void {
  if (!readState(deps.boardDir)?.feed) deps.log(NO_FEED_LINE);
}

/** The feed a start carries forward: a supervised forwarder is reinstalled on the bound port. */
export function carriedFeed(recorded: WebhookFeed): WebhookFeed {
  if (recorded.kind !== 'gh-forward' || recorded.pid !== undefined) return recorded;
  // A recorded machine-wide label rides along so the receiver removes it once.
  return recorded.agent === LEGACY_FORWARDER_LABEL
    ? { kind: 'gh-forward', agent: recorded.agent }
    : { kind: 'gh-forward' };
}

/** Start the receiver in a detached process. No secret: a no-op (poll-only mode). */
export function webhookUp(
  deps: HierarchyDeps,
  portFlag?: string,
  spawner: Spawner = deps.spawnWebhook ?? spawnDetached,
  feed?: WebhookFeed,
  platform: NodeJS.Platform = process.platform,
): WebhookStatus {
  const before = webhookStatus(deps);
  const recorded = readState(deps.boardDir)?.feed;
  const legacy = recorded?.agent === LEGACY_FORWARDER_LABEL;
  const explicitForward = feed?.kind === 'gh-forward' && feed.pid === undefined;
  if (before.state === 'off' && before.reason === 'no secret') {
    if (explicitForward)
      throw new Error(`${WEBHOOK_SECRET_ENV} is not set: cannot start the forwarder`);
    deps.log(`webhook off: ${WEBHOOK_SECRET_ENV} is not set (poll-only mode)`);
    return before;
  }
  if (before.state === 'up') {
    // A running receiver keeps its feed; only a machine-wide label is replaced by the per-board one.
    if (!feed && recorded?.kind === 'gh-forward' && legacy) feed = carriedFeed(recorded);
    let persistError: ForwarderPersistError | undefined;
    if (feed?.kind === 'gh-forward' && feed.pid === undefined) {
      try {
        const supervised = installForwarder(
          deps,
          deps.env[WEBHOOK_SECRET_ENV],
          before.port,
          platform,
        );
        feed = supervised ? { kind: 'gh-forward', agent: forwarderLabel(deps) } : feed;
        if (legacy) removeLegacyForwarder(deps);
      } catch (e) {
        if (!(e instanceof ForwarderPersistError)) throw e;
        persistError = e;
      }
    }
    if (feed) recordFeed(deps.boardDir, feed);
    deps.log(`webhook already running on 127.0.0.1:${before.port}`);
    if (persistError) throw persistError;
    return before;
  }
  // Every start carries the recorded feed forward; the receiver installs the forwarder once bound.
  if (!feed && recorded) feed = carriedFeed(recorded);
  const port = selectPort(deps, portFlag);
  const raw = portFlag ?? deps.env[WEBHOOK_PORT_ENV];
  const pinned = raw !== undefined && raw !== '';
  spawner(process.execPath, [
    deps.binPath ?? process.argv[1] ?? '',
    'webhook',
    'serve',
    '--port',
    String(port),
    '--board-dir',
    deps.boardDir,
    ...(pinned ? [] : ['--scan', 'true']),
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
  return before;
}

/** Rewrite the recorded feed of a running receiver. */
export function recordFeed(boardDir: string, feed: WebhookFeed): void {
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

/** Options of {@link webhookServe}. */
export interface ServeOptions {
  /** Try the next ports when the first is held (an unpinned start). */
  scan?: boolean;
  platform?: NodeJS.Platform;
}

/**
 * Run the receiver in the foreground until SIGTERM or SIGINT. Needs the secret. The receiver
 * binds first; only then are the port recorded and a supervised forwarder installed on it.
 */
export async function webhookServe(
  deps: HierarchyDeps,
  portFlag?: string,
  feed?: WebhookFeed,
  opts: ServeOptions = {},
): Promise<void> {
  const secret = deps.env[WEBHOOK_SECRET_ENV];
  if (!secret) throw new Error(`${WEBHOOK_SECRET_ENV} is not set`);
  let repo: string | undefined;
  try {
    repo = resolveRepo(deps);
  } catch {
    /* unresolvable: accept every delivery; status reads the repository as unknown */
  }
  const first = resolvePort(deps, portFlag);
  const attempts = opts.scan && first !== 0 ? WEBHOOK_PORT_SCAN : 1;
  let receiver: ReturnType<typeof createReceiver> | undefined;
  for (let i = 0; i < attempts && !receiver; i += 1) {
    const port = first + i;
    if (port > 65535) break;
    const candidate = createReceiver({
      secret,
      ...(repo ? { repo } : {}),
      boardDir: deps.boardDir,
      port,
      debounceMs: loadPrLifecycleConfig(deps.cwd).webhook.debounceMs,
    });
    try {
      await candidate.start();
      receiver = candidate;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  if (!receiver) {
    const message = `cannot bind webhook port: port ${first} is held by ${portOwner(deps, first)}`;
    recordCollision(deps.boardDir, message);
    throw new Error(message);
  }
  rmSync(path.join(deps.boardDir, COLLISION_FILE), { force: true });
  mkdirSync(deps.boardDir, { recursive: true });
  writeFileSync(path.join(deps.boardDir, PORT_FILE), `${receiver.port}\n`);
  let recordedFeed = feed;
  if (feed?.kind === 'gh-forward' && feed.pid === undefined) {
    try {
      const supervised = installForwarder(deps, secret, receiver.port, opts.platform);
      recordedFeed = supervised ? { kind: 'gh-forward', agent: forwarderLabel(deps) } : feed;
      if (feed.agent === LEGACY_FORWARDER_LABEL) removeLegacyForwarder(deps);
    } catch (e) {
      if (!(e instanceof ForwarderPersistError)) {
        await receiver.stop();
        throw e;
      }
      // The receiver keeps running; the feed is recorded without an agent, so status says not persisted.
      deps.log((e as Error).message);
      recordedFeed = { kind: 'gh-forward' };
    }
  }
  writeFileSync(
    stateFile(deps.boardDir),
    JSON.stringify({
      pid: process.pid,
      port: receiver.port,
      ...(repo ? { repo } : {}),
      ...(recordedFeed ? { feed: recordedFeed } : {}),
    }) + '\n',
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
