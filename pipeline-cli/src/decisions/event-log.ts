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

import type { GovernanceChange } from './governance-fallback.js';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  formatDecisionId,
  validateDecisionEvent,
  type AutoExpiredEvent,
  type DecisionEvent,
  type DecisionOpenedEvent,
  type DecisionPriority,
  type OperatorAnsweredEvent,
  type TimeboxExtendedEvent,
} from './decision-record.js';

// ── Path resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the decisions directory: `<workDir>/.ai-sdlc/_decisions`.
 */
export function resolveDecisionsDir(workDir: string = process.cwd()): string {
  return join(workDir, '.ai-sdlc', '_decisions');
}

/**
 * Resolve the per-event directory: `<workDir>/.ai-sdlc/_decisions/events/`
 * (AISDLC-719). One file per event, so two pull requests that each record a
 * decision add distinct paths and merge without a text conflict.
 */
export function resolveEventsDir(workDir: string = process.cwd()): string {
  return join(resolveDecisionsDir(workDir), 'events');
}

/**
 * Resolve the LEGACY event log path: `<workDir>/.ai-sdlc/_decisions/events.jsonl`.
 * Still read (never written by default) so existing history stays visible.
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

  // An explicit filePath (tests / tools) keeps the legacy single-file append.
  if (opts.filePath) {
    ensureParentDir(opts.filePath);
    appendFileSync(opts.filePath, JSON.stringify(event) + '\n', { encoding: 'utf8' });
    return opts.filePath;
  }
  const line = JSON.stringify(event);
  const path = join(resolveEventsDir(opts.workDir), eventFileName(event, line));
  ensureParentDir(path);
  writeFileSync(path, line + '\n', { encoding: 'utf8' });
  return path;
}

// ── Per-event file naming (AISDLC-719) ───────────────────────────────────────

/** Short content hash of an event's serialized line; the dedupe key across layouts. */
export function eventContentHash(line: string): string {
  return createHash('sha256').update(line.trim()).digest('hex').slice(0, 12);
}

/**
 * Deterministic, collision-resistant file name for an event:
 * `<ts>__<decisionId>__<type>__<hash12>.json`. Lexicographic order is
 * timestamp order (ISO-8601 UTC), which gives the reader a total order;
 * the content hash breaks same-millisecond ties and makes re-writing the
 * same event idempotent. Colons are replaced for filesystem portability.
 */
export function eventFileName(event: DecisionEvent, line: string = JSON.stringify(event)): string {
  const ts = event.ts.replace(/:/g, '-');
  return `${ts}__${event.decisionId}__${event.type}__${eventContentHash(line)}.json`;
}

/** Hash embedded in an event file name (last `__` segment), or null. */
export function hashFromEventFileName(name: string): string | null {
  const m = name.match(/__([0-9a-f]{12})\.json$/);
  return m ? m[1] : null;
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
  const events: DecisionEvent[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  const ingest = (line: string): void => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      return;
    }
    if (validateDecisionEvent(parsed) !== null) {
      skipped += 1;
      return;
    }
    // Same event present in both layouts (partial migration) counts once.
    const key = eventContentHash(line);
    if (seen.has(key)) return;
    seen.add(key);
    events.push(parsed as DecisionEvent);
  };

  // 1. Legacy single-file log, in append order.
  const legacy = opts.filePath ?? resolveEventLogPath(opts.workDir);
  if (existsSync(legacy)) {
    try {
      for (const line of readFileSync(legacy, 'utf8').split('\n')) ingest(line);
    } catch {
      /* unreadable legacy log: treat as empty */
    }
  }

  // 2. Per-event files, sorted by name (timestamp order). Skipped when an
  //    explicit filePath pins the legacy-only layout.
  if (!opts.filePath) {
    const dir = resolveEventsDir(opts.workDir);
    let names: string[] = [];
    try {
      names = readdirSync(dir)
        .filter((n) => n.endsWith('.json'))
        .sort();
    } catch {
      /* no events dir yet */
    }
    for (const name of names) {
      try {
        ingest(readFileSync(join(dir, name), 'utf8'));
      } catch {
        skipped += 1;
      }
    }
  }
  return { events, skipped };
}

/**
 * Raw serialized event lines from both layouts, newline-joined in read order
 * (legacy file first, then per-event files by name). Diagnostics and tests.
 */
export function readEventLogText(workDir?: string): string {
  const out: string[] = [];
  const legacy = resolveEventLogPath(workDir);
  if (existsSync(legacy)) {
    out.push(
      ...readFileSync(legacy, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== ''),
    );
  }
  const dir = resolveEventsDir(workDir);
  if (existsSync(dir)) {
    for (const n of readdirSync(dir)
      .filter((x) => x.endsWith('.json'))
      .sort()) {
      out.push(readFileSync(join(dir, n), 'utf8').trim());
    }
  }
  return out.length ? out.join('\n') + '\n' : '';
}

// ── Legacy → per-event migration (AISDLC-719) ────────────────────────────────

export interface MigrateResult {
  /** Valid events written as per-event files. */
  migrated: number;
  /** Lines skipped as malformed / invalid (left only in the legacy file). */
  skipped: number;
  /** Whether the legacy file was removed. */
  removedLegacy: boolean;
}

/**
 * Split the legacy `events.jsonl` into per-event files, keeping every event
 * byte-for-byte (ids and history preserved). Migrated files are named
 * `0-legacy-<seq>__...` so they sort before timestamped files and keep the
 * original append order even where legacy timestamps are non-monotonic.
 * Idempotent. The legacy file is removed only when every line migrated.
 */
export function migrateLegacyEventLog(opts: ReadEventsOpts = {}): MigrateResult {
  const legacy = resolveEventLogPath(opts.workDir);
  if (!existsSync(legacy)) return { migrated: 0, skipped: 0, removedLegacy: false };
  const dir = resolveEventsDir(opts.workDir);
  mkdirSync(dir, { recursive: true });
  const have = new Set(
    readdirSync(dir)
      .map(hashFromEventFileName)
      .filter((h): h is string => h !== null),
  );
  let migrated = 0;
  let skipped = 0;
  let seq = 0;
  for (const raw of readFileSync(legacy, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    seq += 1;
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
    const hash = eventContentHash(line);
    if (have.has(hash)) continue;
    const evt = parsed as DecisionEvent;
    const name = `0-legacy-${String(seq).padStart(6, '0')}__${evt.decisionId}__${evt.type}__${hash}.json`;
    writeFileSync(join(dir, name), line + '\n', { encoding: 'utf8' });
    have.add(hash);
    migrated += 1;
  }
  let removedLegacy = false;
  if (skipped === 0) {
    unlinkSync(legacy);
    removedLegacy = true;
  }
  return { migrated, skipped, removedLegacy };
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
  /**
   * RFC-0035 AISDLC-447 — canonical ISO-8601 timebox (categorical aliases
   * pre-resolved by the caller). The factory persists this as-authored on
   * the event; callers should compute + pass `timeboxExpiresAt` in the same
   * call so both fields land atomically.
   */
  timebox?: string;
  /** RFC-0035 AISDLC-447 — pre-computed absolute expiry (ISO-8601 UTC). */
  timeboxExpiresAt?: string;
  /** AISDLC-463 — operator-authored categorical priority. */
  priority?: DecisionPriority;
  /** AISDLC-463 — operator-authored impact score [0,100]. */
  impactScore?: number;
  /** AISDLC-463 — autonomous-fallback option id (must reference an option). */
  autonomousFallbackOptionId?: string;
  /** AISDLC-463 — surfacing-context backlink. */
  contextRef?: string;
  /** AISDLC-703 — governance-change tag (DEC-0053). */
  governanceChange?: GovernanceChange;
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
  if (input.timebox !== undefined) event.timebox = input.timebox;
  if (input.timeboxExpiresAt !== undefined) event.timeboxExpiresAt = input.timeboxExpiresAt;
  if (input.priority !== undefined) event.priority = input.priority;
  if (input.impactScore !== undefined) event.impactScore = input.impactScore;
  if (input.autonomousFallbackOptionId !== undefined) {
    event.autonomousFallbackOptionId = input.autonomousFallbackOptionId;
  }
  if (input.contextRef !== undefined) event.contextRef = input.contextRef;
  if (input.governanceChange !== undefined) event.governanceChange = input.governanceChange;
  if (input.by !== undefined) event.by = input.by;
  return event;
}

// ── Timebox-extended event factory (AISDLC-447) ──────────────────────────────

export interface ExtendTimeboxInput {
  decisionId: string;
  /** Canonical ISO-8601 duration (categorical aliases pre-resolved). */
  newTimebox: string;
  /** Pre-computed absolute expiry (ISO-8601 UTC). */
  newTimeboxExpiresAt: string;
  /** The prior expiry timestamp this extension supersedes (null if none). */
  previousTimeboxExpiresAt: string | null;
  rationale?: string;
  by?: string;
  now?: Date;
}

/**
 * Build a well-formed `timebox-extended` event without writing it. Call
 * {@link appendDecisionEvent} afterwards to persist.
 */
export function makeTimeboxExtendedEvent(input: ExtendTimeboxInput): TimeboxExtendedEvent {
  const ts = (input.now ?? new Date()).toISOString();
  const event: TimeboxExtendedEvent = {
    eventVersion: 'v1',
    type: 'timebox-extended',
    ts,
    decisionId: input.decisionId,
    newTimebox: input.newTimebox,
    newTimeboxExpiresAt: input.newTimeboxExpiresAt,
    previousTimeboxExpiresAt: input.previousTimeboxExpiresAt,
  };
  if (input.rationale !== undefined) event.rationale = input.rationale;
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
  /** AISDLC-463 — surfacing-context backlink captured at resolve time. */
  contextRef?: string;
  /** AISDLC-463 — surfacing agent / surface that raised the decision. */
  surfacingAgent?: string;
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
  if (input.contextRef !== undefined) event.contextRef = input.contextRef;
  if (input.surfacingAgent !== undefined) event.surfacingAgent = input.surfacingAgent;
  if (input.by !== undefined) event.by = input.by;
  return event;
}

// ── Auto-expired event factory (AISDLC-463) ──────────────────────────────────

export interface AutoExpireDecisionInput {
  decisionId: string;
  /** The fallback option id the framework selected. */
  chosenOptionId: string;
  /** Fallback reason, e.g. `"fallback after PT4H timebox"`. */
  rationale: string;
  /** The expiry timestamp that triggered the fallback (ISO-8601 UTC). */
  expiredAt: string;
  /** AISDLC-463 — surfacing-context backlink carried over from spec.contextRef. */
  contextRef?: string;
  now?: Date;
}

/**
 * Build a well-formed `auto-expired` event without writing it. Call
 * {@link appendDecisionEvent} afterwards to persist.
 *
 * AISDLC-463 — emitted by `cli-decisions auto-expire`. The factory hard-codes
 * `by: 'auto-expired'` so the audit trail distinguishes the autonomous
 * fallback from an operator answer, even though the projection also folds the
 * lifecycle to `answered`.
 */
export function makeAutoExpiredEvent(input: AutoExpireDecisionInput): AutoExpiredEvent {
  const ts = (input.now ?? new Date()).toISOString();
  const event: AutoExpiredEvent = {
    eventVersion: 'v1',
    type: 'auto-expired',
    ts,
    decisionId: input.decisionId,
    chosenOptionId: input.chosenOptionId,
    rationale: input.rationale,
    expiredAt: input.expiredAt,
    by: 'auto-expired',
  };
  if (input.contextRef !== undefined) event.contextRef = input.contextRef;
  return event;
}
