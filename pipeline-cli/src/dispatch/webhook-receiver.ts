/**
 * Local GitHub webhook receiver for the PR lifecycle (RFC-0054, AISDLC-880).
 *
 * A delivery is a trigger, never a fact: after the HMAC check the receiver
 * stores one event record and wakes the reconciler. Every fact is re-read over
 * REST later. The receiver binds to 127.0.0.1 only and never classifies or acts.
 *
 * The only payload fields read are `repository.full_name`, the PR number and
 * the head sha (per event kind, see `extractTarget`). The kind and delivery id
 * come from the `X-GitHub-Event` / `X-GitHub-Delivery` headers, `receivedAt`
 * from the local clock.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

import { createWebhookServer, verifyGitHubSignature, type WebhookServer } from '@ai-sdlc/reference';

import { now as clockNow } from '../clock.js';

/** Event kinds the receiver records; any other delivery is acknowledged and dropped. */
export const WEBHOOK_EVENT_KINDS = [
  'pull_request',
  'check_suite',
  'check_run',
  'workflow_run',
  'status',
  'pull_request_review',
  // AISDLC-1379: only a push to the default branch is recorded; it can change what every open PR rebases onto.
  'push',
  // AISDLC-1023: posted by main-health-monitor.yml, not by GitHub itself.
  'pipeline-canary-red',
  'pipeline-canary-green',
] as const;
export type WebhookEventKind = (typeof WEBHOOK_EVENT_KINDS)[number];

/** The stored record: exactly these keys and nothing else. */
export interface EventRecord {
  repo: string;
  /** PR number, or null for a `status` delivery (it names a commit, not a PR). */
  pr: number | null;
  headSha: string;
  kind: WebhookEventKind;
  deliveryId: string;
  receivedAt: string;
  /** Canary events only: the failing step and output (capped). */
  detail?: string;
}

export const DEFAULT_DEBOUNCE_MS = 5000;
export const WEBHOOK_PATH = '/webhooks/github';
const MAX_DETAIL = 4000;
/** Touched by the receiver to wake the reconciler, under the board dir. */
export const WAKE_FILE = '.reconcile-wake';
/** Deliveries refused for a bad signature since the last verified one (AISDLC-1285). */
export const REFUSED_FILE = 'webhook-refused.json';

function recordRefusal(boardDir: string, at: Date): void {
  try {
    const file = path.join(boardDir, REFUSED_FILE);
    let count = 0;
    try {
      count = Number(JSON.parse(readFileSync(file, 'utf-8')).count) || 0;
    } catch {
      /* first refusal */
    }
    mkdirSync(boardDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ at: at.toISOString(), count: count + 1 }) + '\n');
  } catch {
    /* health bookkeeping must not break the receiver */
  }
}

/** Signed deliveries for another repository, refused (AISDLC-1349). */
export const FOREIGN_FILE = 'webhook-foreign.json';

function recordForeign(boardDir: string, repo: string, at: Date): void {
  try {
    const file = path.join(boardDir, FOREIGN_FILE);
    let count = 0;
    try {
      count = Number(JSON.parse(readFileSync(file, 'utf-8')).count) || 0;
    } catch {
      /* first foreign delivery */
    }
    mkdirSync(boardDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ at: at.toISOString(), count: count + 1, repo }) + '\n');
  } catch {
    /* health bookkeeping must not break the receiver */
  }
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;
const DELIVERY_RE = /^[A-Za-z0-9-]{1,100}$/;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  typeof v === 'object' && v !== null ? (v as Obj) : undefined;
const posInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;

/** Pull the repo, PR number and head sha out of a delivery; undefined when absent or malformed. */
function extractTarget(
  kind: WebhookEventKind,
  p: Obj,
): { repo: string; pr: number | null; headSha: string } | undefined {
  const repo = obj(p.repository)?.full_name;
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) return undefined;
  let pr: number | null | undefined;
  let sha: unknown;
  if (kind === 'pipeline-canary-red' || kind === 'pipeline-canary-green') {
    pr = null;
    sha = p.sha;
  } else if (kind === 'pull_request' || kind === 'pull_request_review') {
    const pull = obj(p.pull_request);
    pr = posInt(pull?.number);
    sha = obj(pull?.head)?.sha;
  } else if (kind === 'status') {
    pr = null;
    sha = p.sha;
  } else if (kind === 'push') {
    const branch = obj(p.repository)?.default_branch;
    const def = typeof branch === 'string' && branch ? branch : 'main';
    if (p.ref !== `refs/heads/${def}`) return undefined;
    pr = null;
    sha = p.after;
  } else {
    const run = obj(p[kind]);
    const first = Array.isArray(run?.pull_requests) ? obj(run.pull_requests[0]) : undefined;
    pr = first ? posInt(first.number) : null;
    sha = run?.head_sha;
  }
  if (pr === undefined || typeof sha !== 'string' || !SHA_RE.test(sha)) return undefined;
  return { repo, pr, headSha: sha };
}

/** Kinds that name a run on a commit; with no PR they are main-branch noise (AISDLC-1379). */
const RUN_KINDS: readonly WebhookEventKind[] = ['check_run', 'check_suite', 'workflow_run'];

/** True when the event belongs to no PR and is a run event: recorded for health, but it wakes nothing. */
export function isNoPrRunEvent(r: { pr: number | null; kind: string }): boolean {
  return r.pr === null && (RUN_KINDS as readonly string[]).includes(r.kind);
}

/** `<repo>#<pr>@<headSha>:<kind>:<deliveryId>`, made safe as a file name. */
export function eventFileName(r: EventRecord): string {
  const key = `${r.repo}#${r.pr ?? 'none'}@${r.headSha}:${r.kind}:${r.deliveryId}`;
  return `${encodeURIComponent(key)}.json`;
}

/** Create the record if absent. Returns true when a file was written, false on a replay. */
export function writeEventRecord(eventsDir: string, record: EventRecord): boolean {
  mkdirSync(eventsDir, { recursive: true });
  let fd: number;
  try {
    fd = openSync(path.join(eventsDir, eventFileName(record)), 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(record) + '\n');
  } finally {
    closeSync(fd);
  }
  return true;
}

export interface ReceiverOptions {
  secret: string;
  /** Dispatch board dir; records go to `<boardDir>/events/`, the wake file to `<boardDir>/.reconcile-wake`. */
  boardDir: string;
  /** 0 picks a free port. */
  port: number;
  /**
   * `owner/repo` this board serves. A delivery for another repository is refused and recorded.
   * Absent when unresolvable: every delivery is accepted and status reads the repository as unknown.
   */
  repo?: string;
  debounceMs?: number;
  now?: () => Date;
  /** Replaces the wake-file touch (tests). */
  wake?: () => void;
}

export interface Receiver {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly port: number;
}

/** Touch (create or bump mtime of) the wake file. */
export function touchWakeFile(boardDir: string): void {
  mkdirSync(boardDir, { recursive: true });
  const file = path.join(boardDir, WAKE_FILE);
  closeSync(openSync(file, 'a'));
  const t = clockNow();
  utimesSync(file, t, t);
}

export function createReceiver(opts: ReceiverOptions): Receiver {
  const server: WebhookServer = createWebhookServer({
    port: opts.port,
    host: '127.0.0.1',
    healthInfo: () => ({ repo: opts.repo ?? null, boardDir: path.resolve(opts.boardDir) }),
  });
  const eventsDir = path.join(opts.boardDir, 'events');
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const now = opts.now ?? clockNow;
  const wake = opts.wake ?? (() => touchWakeFile(opts.boardDir));
  const timers = new Map<string, NodeJS.Timeout>();

  const scheduleWake = (key: string): void => {
    if (timers.has(key)) return;
    const t = setTimeout(() => {
      timers.delete(key);
      try {
        wake();
      } catch {
        /* the poll reconciler still catches up */
      }
    }, debounceMs);
    t.unref();
    timers.set(key, t);
  };

  server.registerProvider({
    path: WEBHOOK_PATH,
    verifySignature: (headers, body) => {
      const ok = verifyGitHubSignature(opts.secret, headers, body);
      if (ok) rmSync(path.join(opts.boardDir, REFUSED_FILE), { force: true });
      else recordRefusal(opts.boardDir, now());
      return ok;
    },
    onEvent: (headers, body) => {
      const kind = headers['x-github-event'] as WebhookEventKind | undefined;
      const deliveryId = headers['x-github-delivery'];
      const payload = obj(body);
      if (!kind || !WEBHOOK_EVENT_KINDS.includes(kind) || !payload) return;
      if (!deliveryId || !DELIVERY_RE.test(deliveryId)) return;
      const target = extractTarget(kind, payload);
      if (!target) return;
      if (opts.repo && target.repo.toLowerCase() !== opts.repo.toLowerCase()) {
        recordForeign(opts.boardDir, target.repo, now());
        return;
      }
      const record: EventRecord = {
        ...target,
        kind,
        deliveryId,
        receivedAt: now().toISOString(),
        ...(kind === 'pipeline-canary-red' && typeof payload.detail === 'string'
          ? { detail: payload.detail.slice(0, MAX_DETAIL) }
          : {}),
      };
      if (writeEventRecord(eventsDir, record) && !isNoPrRunEvent(record)) {
        scheduleWake(`${record.repo}#${record.pr ?? 'none'}@${record.headSha}`);
      }
    },
  });

  return {
    start: () => server.start(),
    async stop() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      await server.stop();
    },
    get port() {
      return server.port;
    },
  };
}
