/**
 * `_operator/decisions.jsonl` writer + transition tracker
 * (RFC-0023 §10 / AC#1, #9 / AISDLC-178.6).
 *
 * Two surfaces:
 *
 *   1. `writeDecision()` — pure JSONL appender that anyone (the plugin's
 *      `mcp__backlog__task_edit` wrapper, future MCP servers, etc.) can
 *      call when they observe a `Needs Clarification → other-status`
 *      transition. Best-effort + feature-flag gated.
 *
 *   2. `DecisionsTracker` — stateful detector that the TUI runs alongside
 *      the backlog walker. Each `observe()` call ingests the latest task
 *      list snapshot; transitions detected against the previous snapshot
 *      are emitted via `writeDecision()`. Lets the TUI capture decisions
 *      even when the operator edits backlog files outside the MCP path
 *      (manual `vim`, IDE save, etc.).
 *
 * Time-to-decision (AC#9) = `resolvedAt - clarificationPostedAt` —
 * computed from the wall-clock timestamps the tracker observed for those
 * transitions. The clarification-posted instant is when a task first
 * entered `Needs Clarification`; the resolved instant is when it left.
 *
 * Records are append-only — the file is the single source of truth and
 * no updates / rewrites ever happen.
 */

import { appendJsonlRecord, type AppendJsonlOpts } from './jsonl-append.js';
import { decisionsPath } from './paths.js';
import { isTelemetryEnabled } from './feature-flag.js';
import type { BacklogTask } from '../sources/backlog-walker.js';

/** Status string the heuristic recognizes as "operator owes a decision". */
export const NEEDS_CLARIFICATION_STATUS = 'Needs Clarification';

/**
 * One record on `decisions.jsonl`. The schema is intentionally narrow —
 * downstream consumers (metrics, future SaaS rollup) read only these
 * fields and additional fields can be added without breaking them.
 */
export interface DecisionRecord {
  /** ISO-8601 wall-clock when the transition was observed. */
  ts: string;
  /** Canonical task ID (e.g. `AISDLC-178.6`). */
  taskId: string;
  /** Always `Needs Clarification` — kept explicit for forward-compat. */
  fromStatus: string;
  /** Whatever status the task moved into (Done, In Progress, Blocked, etc.). */
  toStatus: string;
  /** ISO-8601 of the entry-into-Needs-Clarification (== first sighting). */
  clarificationPostedAt: string;
  /** ISO-8601 of the leave-Needs-Clarification (== `ts`). */
  resolvedAt: string;
  /** Wall-clock duration spent in Needs Clarification, in ms. */
  durationMs: number;
}

export interface WriteDecisionOpts extends AppendJsonlOpts {
  /** Override the artifacts directory (tests). */
  artifactsDir?: string;
  /** Override the env predicate (tests pass `() => true` to bypass the gate). */
  isEnabled?: () => boolean;
}

/**
 * Append one decision record. Best-effort; returns false when the
 * telemetry flag is off or the write threw.
 *
 * Production callers (the eventual MCP-tool wrapper or the in-TUI
 * tracker) typically pass `record` already populated; this function
 * does not synthesize fields beyond what the caller supplied.
 */
export function writeDecision(record: DecisionRecord, opts: WriteDecisionOpts = {}): boolean {
  const enabled = (opts.isEnabled ?? isTelemetryEnabled)();
  if (!enabled) return false;
  return appendJsonlRecord(
    decisionsPath(opts.artifactsDir),
    record as unknown as Record<string, unknown>,
    {
      logger: opts.logger,
      loggerTag: '[tui-analytics:decisions]',
    },
  );
}

// ── Tracker ──────────────────────────────────────────────────────────

export interface DecisionsTrackerOpts extends WriteDecisionOpts {
  /** Inject the writer (tests). Defaults to `writeDecision`. */
  writer?: (record: DecisionRecord, opts?: WriteDecisionOpts) => boolean;
  /** Inject a clock for the `ts`/`resolvedAt` field. Defaults `() => new Date()`. */
  now?: () => Date;
}

interface TrackedEntry {
  status: string;
  /** ISO-8601 wall-clock when the task first entered Needs Clarification. */
  clarificationPostedAt: string | null;
}

/**
 * Detects `Needs Clarification → *` transitions across successive task
 * list snapshots and emits decision records.
 *
 * Cold-start contract: the very first `observe()` call seeds the
 * baseline — no transitions are emitted (we have no prior state to
 * diff against). Subsequent calls produce one record per detected
 * transition.
 *
 * Tasks that disappear from the snapshot (file deleted) do not emit a
 * decision — their status is "unknown", not "transitioned".
 */
export class DecisionsTracker {
  private readonly entries = new Map<string, TrackedEntry>();
  private seeded = false;

  constructor(private readonly opts: DecisionsTrackerOpts = {}) {}

  /**
   * Ingest a fresh snapshot. Returns the records emitted on this call
   * (so tests can assert without round-tripping through the writer).
   */
  observe(tasks: ReadonlyArray<BacklogTask>): DecisionRecord[] {
    const writer = this.opts.writer ?? writeDecision;
    const now = (this.opts.now ?? ((): Date => new Date()))();
    const nowIso = now.toISOString();
    const emitted: DecisionRecord[] = [];

    for (const task of tasks) {
      const prev = this.entries.get(task.id);
      const nextStatus = task.status;

      if (!prev) {
        // First sighting — record the current status. If it's already
        // Needs Clarification, treat *now* as the clarification-posted
        // instant (we have no earlier observation to attribute it to).
        this.entries.set(task.id, {
          status: nextStatus,
          clarificationPostedAt: nextStatus === NEEDS_CLARIFICATION_STATUS ? nowIso : null,
        });
        continue;
      }

      // Track entry into Needs Clarification — start the timer.
      if (nextStatus === NEEDS_CLARIFICATION_STATUS && prev.status !== NEEDS_CLARIFICATION_STATUS) {
        this.entries.set(task.id, { status: nextStatus, clarificationPostedAt: nowIso });
        continue;
      }

      // Track exit from Needs Clarification — emit one record.
      if (
        prev.status === NEEDS_CLARIFICATION_STATUS &&
        nextStatus !== NEEDS_CLARIFICATION_STATUS &&
        this.seeded
      ) {
        const postedAt = prev.clarificationPostedAt ?? nowIso;
        const durationMs = Math.max(0, now.getTime() - new Date(postedAt).getTime());
        const record: DecisionRecord = {
          ts: nowIso,
          taskId: task.id,
          fromStatus: NEEDS_CLARIFICATION_STATUS,
          toStatus: nextStatus,
          clarificationPostedAt: postedAt,
          resolvedAt: nowIso,
          durationMs,
        };
        emitted.push(record);
        writer(record, this.opts);
        this.entries.set(task.id, { status: nextStatus, clarificationPostedAt: null });
        continue;
      }

      // Same status (or any other transition we don't track) — just
      // refresh the cached status so future transitions see the latest.
      if (nextStatus !== prev.status) {
        this.entries.set(task.id, {
          status: nextStatus,
          clarificationPostedAt: prev.clarificationPostedAt,
        });
      }
    }

    this.seeded = true;
    return emitted;
  }

  /** Test-only: peek at internal state without exposing the map shape. */
  hasSeeded(): boolean {
    return this.seeded;
  }
}
