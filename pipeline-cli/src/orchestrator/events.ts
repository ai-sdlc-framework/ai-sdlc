/**
 * Append-only events writer for the autonomous-pipeline orchestrator
 * (RFC-0015 Phase 4 / AISDLC-169.4).
 *
 * `writeEvent()` appends one JSONL line to a date-rotated file at
 * `$ARTIFACTS_DIR/_orchestrator/events-YYYY-MM-DD.jsonl`. The writer is
 * pure I/O — no formatting beyond `JSON.stringify(event) + '\n'` — and
 * creates parent directories on demand. Per RFC §7.3 the contract is
 * "the file exists, it's append-only, it's schema-stable"; the writer
 * never mutates existing lines + never reorders.
 *
 * Feature-flag gated: when `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` is OFF the
 * writer is a no-op. This keeps the production surface dark for
 * operators who haven't opted into the orchestrator AND lets the loop
 * call `writeEvent()` unconditionally without leaking events when the
 * flag flips off mid-run.
 *
 * Best-effort by design: write failures are swallowed (one log line via
 * the optional logger) so a transient disk-full / EBADF never crashes
 * the orchestrator hot loop. The schema is published at
 * `spec/schemas/orchestrator-events.v1.schema.json` for downstream
 * consumers (cli-status --orchestrator, future web dashboard, Slack
 * push, etc.).
 *
 * @module orchestrator/events
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { isOrchestratorEnabled } from './feature-flag.js';
import type { PipelineLogger } from '../types.js';

// ── Event type ────────────────────────────────────────────────────────

/**
 * Discriminator for the seven Phase 4 event types. Future phases / RFCs
 * extend this without a schema bump — see `spec/schemas/orchestrator-events.v1.schema.json`.
 */
export type OrchestratorEventType =
  | 'OrchestratorTick'
  | 'OrchestratorDispatched'
  | 'OrchestratorCompleted'
  | 'OrchestratorFailed'
  | 'OrchestratorRecovered'
  | 'OrchestratorAwaitingExternal'
  | 'WorkerStateTransition';

/**
 * One JSONL line on the events stream. Common envelope (`ts`, optional
 * `taskId`, optional `runId`, optional `tick`) rides on every event;
 * per-type fields are documented in the JSON Schema and tolerated by
 * the writer as additional properties.
 *
 * The shape mirrors `spec/schemas/orchestrator-events.v1.schema.json`.
 * Keeping it `Record<string, unknown>` at the type level (with required
 * `ts` + `type`) lets the loop emit per-type payloads without a per-type
 * TypeScript discriminated-union maintenance burden — the schema file is
 * the source of truth for downstream consumers.
 */
export interface OrchestratorEvent {
  /** ISO-8601 timestamp set by the writer at append time. */
  ts: string;
  /** Discriminator. */
  type: OrchestratorEventType;
  /** Task scope when applicable (orchestrator-level events omit this). */
  taskId?: string;
  /** Orchestrator session UUID — stable across all ticks within one run. */
  runId?: string;
  /** Tick number this event was emitted in (0-indexed). */
  tick?: number;
  /** Worker identifier — present on worker-scoped events. */
  workerId?: string;
  /** Per-type payload — see schema for the per-type field set. */
  [k: string]: unknown;
}

// ── Writer options ────────────────────────────────────────────────────

export interface WriteEventOpts {
  /**
   * Override the artifacts directory. Falls back to env then `./artifacts`.
   * Production callers usually leave this undefined.
   */
  artifactsDir?: string;
  /**
   * Override `Date.now()` for the rotation date suffix + the event's
   * `ts` field when the caller didn't pre-stamp it. Tests inject a
   * frozen clock; production leaves it undefined.
   */
  now?: () => Date;
  /**
   * Optional logger — surfaces best-effort write failures. Defaults to
   * silent (per RFC §7.3 the writer is best-effort + never throws).
   */
  logger?: PipelineLogger;
  /**
   * Override the env predicate. Tests pass `() => true` to bypass the
   * feature-flag gate without mutating `process.env`. Production leaves
   * this undefined.
   */
  isEnabled?: () => boolean;
}

// ── Path helpers ──────────────────────────────────────────────────────

/**
 * Resolve the on-disk path for the date-rotated events file. Exported
 * so the cli-status view + tests can derive the same path without
 * duplicating the rotation logic.
 */
export function eventsFilePath(artifactsDir: string, date: Date = new Date()): string {
  return join(artifactsDir, '_orchestrator', `events-${formatDate(date)}.jsonl`);
}

/**
 * Resolve the directory holding the rotated events files. Lets callers
 * (cli-status) enumerate every events file across all dates without
 * coupling to the rotation suffix format.
 */
export function eventsDirPath(artifactsDir: string): string {
  return join(artifactsDir, '_orchestrator');
}

function formatDate(d: Date): string {
  // YYYY-MM-DD in UTC — keeps rotation deterministic across operator
  // timezones (orchestrators run in containers that often default to UTC
  // anyway, but explicit UTC guarantees no DST seam at midnight).
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function resolveArtifactsDir(opts: WriteEventOpts): string {
  return opts.artifactsDir ?? process.env.ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts');
}

// ── Writer ────────────────────────────────────────────────────────────

/**
 * Append one event line to the date-rotated events file.
 *
 * Per RFC §7.3 the writer is best-effort: feature-flag gated (no-op when
 * off), creates parent dirs if missing, swallows write errors so the
 * orchestrator hot loop is never crashed by a transient disk hiccup.
 *
 * The writer stamps `ts` if the caller didn't pre-set it — this is the
 * common path since most callers mint the event at the same instant they
 * call writeEvent().
 *
 * Returns `true` when the line was appended, `false` when it was skipped
 * (flag off OR write threw). The boolean is for tests; production
 * callers can ignore it.
 */
export function writeEvent(event: OrchestratorEvent, opts: WriteEventOpts = {}): boolean {
  const enabled = (opts.isEnabled ?? isOrchestratorEnabled)();
  if (!enabled) return false;

  const artifactsDir = resolveArtifactsDir(opts);
  const now = opts.now ?? ((): Date => new Date());
  const date = now();
  const stamped: OrchestratorEvent = { ...event, ts: event.ts || date.toISOString() };
  const path = eventsFilePath(artifactsDir, date);
  const line = JSON.stringify(stamped) + '\n';

  try {
    if (!existsSync(dirname(path))) {
      mkdirSync(dirname(path), { recursive: true });
    }
    appendFileSync(path, line, { encoding: 'utf8' });
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    opts.logger?.warn(`[orchestrator-events] write failed (path=${path}): ${reason}`);
    return false;
  }
}

// ── Reader (for cli-status --orchestrator) ────────────────────────────

export interface ReadEventsOpts {
  /** Override the artifacts directory. */
  artifactsDir?: string;
  /**
   * Cap on the number of most-recent events returned across all
   * date-rotated files. Defaults to 50 per the cli-status contract.
   */
  limit?: number;
}

/**
 * Read the most-recent N events across every date-rotated events file
 * under `<artifactsDir>/_orchestrator/`. Returns oldest→newest within
 * the slice (so callers can render in chronological order).
 *
 * Best-effort like the writer: malformed JSON lines are skipped (one
 * silent drop per bad line), missing files return `[]`. The cli-status
 * view + future dashboard consumers ride this surface.
 */
export function readRecentEvents(opts: ReadEventsOpts = {}): OrchestratorEvent[] {
  const artifactsDir =
    opts.artifactsDir ?? process.env.ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts');
  const limit = Math.max(0, opts.limit ?? 50);
  if (limit === 0) return [];

  const dir = eventsDirPath(artifactsDir);
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    return [];
  }
  // Lexicographic sort on YYYY-MM-DD doubles as chronological — newest last.
  files.sort();

  const collected: OrchestratorEvent[] = [];
  // Walk newest-file-first so we can short-circuit once we have enough.
  for (let i = files.length - 1; i >= 0 && collected.length < limit; i -= 1) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, files[i]), 'utf8');
    } catch {
      continue;
    }
    const lines = raw.split('\n');
    // Walk lines newest-first within a file (file is append-only so the
    // last non-empty line is the newest event).
    for (let j = lines.length - 1; j >= 0 && collected.length < limit; j -= 1) {
      const line = lines[j];
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as OrchestratorEvent;
        if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
          collected.push(parsed);
        }
      } catch {
        // Malformed line — skip silently per the best-effort contract.
      }
    }
  }
  // We collected newest-first; reverse so callers render oldest→newest.
  return collected.reverse();
}
