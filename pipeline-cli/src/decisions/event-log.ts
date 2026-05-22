/**
 * RFC-0035 Decision Catalog event log — append-only JSONL substrate.
 *
 * Layout: `<workDir>/.ai-sdlc/_decisions/events.jsonl` (OQ-1 resolution —
 * sibling to RFC-0015's existing `events.jsonl` substrate, kept under
 * `.ai-sdlc/` rather than `$ARTIFACTS_DIR/` because Decisions are
 * first-class workspace artefacts the operator wants checked in / replayed
 * across worktrees, not transient run artefacts).
 *
 * Per OQ-1: events are never mutated or reordered. Schema evolution is
 * additive only (new event types appended). The reader tolerates unknown
 * event types (forward-compat) and silently skips malformed lines (the
 * file is operator-edited in degraded scenarios, so we don't abort on
 * a single bad line).
 *
 * @module decisions/event-log
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  formatDecisionId,
  validateDecisionEvent,
  type DecisionEvent,
  type DecisionOpenedEvent,
  type OperatorAnsweredEvent,
} from './decision-record.js';

// ── Path resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the decisions directory: `<workDir>/.ai-sdlc/_decisions`.
 */
export function resolveDecisionsDir(workDir: string = process.cwd()): string {
  return join(workDir, '.ai-sdlc', '_decisions');
}

/**
 * Resolve the event log path: `<workDir>/.ai-sdlc/_decisions/events.jsonl`.
 */
export function resolveEventLogPath(workDir: string = process.cwd()): string {
  return join(resolveDecisionsDir(workDir), 'events.jsonl');
}

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── File lock (AISDLC-395 round-1 MAJOR #2) ──────────────────────────────────

/**
 * Cross-process advisory lock around the event log. Used by callers that
 * need atomic `nextDecisionId()` + `appendDecisionEvent()` so two concurrent
 * orchestrator ticks cannot allocate the same DEC-NNNN id.
 *
 * Implementation: `open(path, 'wx')` (O_CREAT | O_EXCL) on a sibling
 * `<events.jsonl>.lock` file. The first process to win creates the file;
 * concurrent attempts get EEXIST and retry. Stale locks (older than
 * `STALE_LOCK_MS`) are forcibly cleared — a crashed process must not block
 * the orchestrator indefinitely.
 */
const STALE_LOCK_MS = 30_000;
const LOCK_RETRY_INTERVAL_MS = 25;
const LOCK_MAX_WAIT_MS = 5_000;

function lockPathFor(eventLogPath: string): string {
  return `${eventLogPath}.lock`;
}

function clearIfStale(lockPath: string): void {
  try {
    const st = statSync(lockPath);
    if (Date.now() - st.mtimeMs > STALE_LOCK_MS) unlinkSync(lockPath);
  } catch {
    // lock file disappeared between stat and unlink — fine.
  }
}

// Synchronous sleep that yields the thread (vs a CPU-pinning busy-wait).
// Uses Atomics.wait on a private SharedArrayBuffer — supported since Node 14.
function syncSleepMs(ms: number): void {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

export function acquireEventLogLock(opts: ReadEventsOpts = {}): () => void {
  const path = opts.filePath ?? resolveEventLogPath(opts.workDir);
  ensureParentDir(path);
  const lockPath = lockPathFor(path);
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  let fd: number | null = null;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch (err) {
      lastErr = err;
      clearIfStale(lockPath);
      syncSleepMs(LOCK_RETRY_INTERVAL_MS);
    }
  }
  if (fd === null) {
    throw new Error(
      `[decisions] could not acquire event-log lock at ${lockPath} within ${LOCK_MAX_WAIT_MS}ms` +
        (lastErr instanceof Error ? `: ${lastErr.message}` : ''),
    );
  }
  return function release(): void {
    try {
      closeSync(fd as number);
    } catch {
      /* ignore — best-effort close */
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore — lock file already gone */
    }
  };
}

/**
 * Run `fn` while holding the event-log lock. Use this whenever a caller
 * needs allocate-and-append atomicity — `nextDecisionId()` followed by
 * `appendDecisionEvent()`. Reads inside the closure see a stable file.
 */
export function withEventLogLock<T>(opts: ReadEventsOpts, fn: () => T): T {
  const release = acquireEventLogLock(opts);
  try {
    return fn();
  } finally {
    release();
  }
}

// ── Writer ───────────────────────────────────────────────────────────────────

export interface AppendEventOpts {
  /** Override the work directory (defaults to process.cwd()). */
  workDir?: string;
  /** Override the on-disk path entirely (tests). */
  filePath?: string;
}

/**
 * Append one event line to the decisions event log.
 *
 * Per RFC §11 / OQ-1 the file is strictly append-only. The writer validates
 * the event structurally before writing and throws if validation fails (a
 * malformed event corrupts the log for every future reader, so failing fast
 * here is the only sane behaviour).
 *
 * Returns the absolute path the event was appended to.
 */
export function appendDecisionEvent(event: DecisionEvent, opts: AppendEventOpts = {}): string {
  const err = validateDecisionEvent(event);
  if (err) throw new Error(`[decisions] refusing to append invalid event: ${err}`);

  const path = opts.filePath ?? resolveEventLogPath(opts.workDir);
  ensureParentDir(path);
  appendFileSync(path, JSON.stringify(event) + '\n', { encoding: 'utf8' });
  return path;
}

// ── Reader ───────────────────────────────────────────────────────────────────

export interface ReadEventsOpts {
  workDir?: string;
  filePath?: string;
}

export interface ReadEventsResult {
  /** Parsed + structurally-valid events, in file order (append order). */
  events: DecisionEvent[];
  /** Count of lines skipped because they were malformed or invalid. */
  skipped: number;
}

/**
 * Read every event from the log in append order. Malformed lines are
 * silently skipped (counted in `skipped`). A missing file returns
 * `{ events: [], skipped: 0 }`.
 */
export function readDecisionEvents(opts: ReadEventsOpts = {}): ReadEventsResult {
  const path = opts.filePath ?? resolveEventLogPath(opts.workDir);
  if (!existsSync(path)) return { events: [], skipped: 0 };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { events: [], skipped: 0 };
  }

  const events: DecisionEvent[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (validateDecisionEvent(parsed) !== null) {
      skipped += 1;
      continue;
    }
    events.push(parsed as DecisionEvent);
  }
  return { events, skipped };
}

// ── ID allocation ────────────────────────────────────────────────────────────

/**
 * Compute the next DEC-NNNN id from the existing event log. The id space
 * is monotonic and never reused — even if a Decision is later superseded
 * or archived, its id stays consumed. Returns `DEC-0001` when the log is
 * empty.
 */
export function nextDecisionId(opts: ReadEventsOpts = {}): string {
  const { events } = readDecisionEvents(opts);
  let max = 0;
  for (const evt of events) {
    const m = evt.decisionId.match(/^DEC-(\d+)$/);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return formatDecisionId(max + 1);
}

// ── Open-event factory ───────────────────────────────────────────────────────

export interface OpenDecisionInput {
  decisionId?: string;
  source: DecisionOpenedEvent['source'];
  scope: string;
  summary: string;
  body?: string;
  reversible?: boolean;
  options: DecisionOpenedEvent['options'];
  dependsOn?: string[];
  routing?: DecisionOpenedEvent['routing'];
  capacity?: DecisionOpenedEvent['capacity'];
  deadline?: string | null;
  by?: string;
  now?: Date;
}

/**
 * Build a well-formed `decision-opened` event without writing it. Useful
 * for tests that want to verify shape before committing the event to the
 * log. `cli-decisions add` calls this then forwards to {@link appendDecisionEvent}.
 */
export function makeDecisionOpenedEvent(input: OpenDecisionInput): DecisionOpenedEvent {
  const ts = (input.now ?? new Date()).toISOString();
  const event: DecisionOpenedEvent = {
    eventVersion: 'v1',
    type: 'decision-opened',
    ts,
    decisionId: input.decisionId ?? 'DEC-0001',
    source: input.source,
    scope: input.scope,
    summary: input.summary,
    options: input.options,
  };
  if (input.body !== undefined) event.body = input.body;
  if (input.reversible !== undefined) event.reversible = input.reversible;
  if (input.dependsOn !== undefined) event.dependsOn = input.dependsOn;
  if (input.routing !== undefined) event.routing = input.routing;
  if (input.capacity !== undefined) event.capacity = input.capacity;
  if (input.deadline !== undefined) event.deadline = input.deadline;
  if (input.by !== undefined) event.by = input.by;
  return event;
}

// ── Operator-answered event factory (Phase 4) ────────────────────────────────

export interface AnswerDecisionInput {
  decisionId: string;
  /** The `id` of the chosen `DecisionOption`. */
  chosenOptionId: string;
  /** Optional free-text rationale for the choice. */
  rationale?: string;
  /** Actor email / login identifier. */
  by?: string;
  now?: Date;
}

/**
 * Build a well-formed `operator-answered` event without writing it.
 * Call {@link appendDecisionEvent} afterwards to persist.
 *
 * RFC-0035 Phase 4 — AC#3: operator answers feed back into Decision
 * resolution. The projection folds this event to set `lifecycle: 'answered'`.
 */
export function makeOperatorAnsweredEvent(input: AnswerDecisionInput): OperatorAnsweredEvent {
  const ts = (input.now ?? new Date()).toISOString();
  const event: OperatorAnsweredEvent = {
    eventVersion: 'v1',
    type: 'operator-answered',
    ts,
    decisionId: input.decisionId,
    chosenOptionId: input.chosenOptionId,
  };
  if (input.rationale !== undefined) event.rationale = input.rationale;
  if (input.by !== undefined) event.by = input.by;
  return event;
}
