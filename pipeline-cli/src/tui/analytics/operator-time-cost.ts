/**
 * RFC-0025 §7.1 / OQ-9 — Instrumented operator-time-cost computation.
 * Phase 5 (AISDLC-306).
 *
 * Computes elapsed-time from `OrchestratorBlockedByX` events to
 * `OperatorActionTaken` events using the RFC-0015 `events.jsonl` substrate.
 *
 * The operator-time-cost metric answers: "when the framework blocked on an
 * operator decision, how much actual operator time did that cost?" This is
 * distinct from wall-clock duration — if the operator was AFK for 2 hours
 * before responding, only the active-session portion counts.
 *
 * ─────────────────────────────────────────────────────────────────────
 * AFK noise filter (OQ-9 resolution 2026-05-15)
 * ─────────────────────────────────────────────────────────────────────
 * Large gaps between consecutive events within a blocked span are excluded
 * from the cost computation. When any inter-event gap exceeds
 * `afkInactivityMinutes` (default 30), the gap is treated as "operator
 * walked away" and zeroed out. The remaining active intervals are summed
 * to produce the active cost estimate.
 *
 * This matches the Sentry / Linear / PagerDuty convention: instrument
 * "time to acknowledge" with inactivity gaps filtered.
 *
 * ─────────────────────────────────────────────────────────────────────
 * RFC-0035 §7 fatigue-signal composition (OQ-9 resolution 2026-05-15)
 * ─────────────────────────────────────────────────────────────────────
 * The operator-time-cost output carries an `rfc0035FatigueSignal` flag
 * (always `false` until RFC-0035 Phase 7 / AISDLC-291 ships). When the
 * flag flips, the fatigue aggregator can subscribe to this module's output
 * without a refactor — the composition seam is already wired.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Detection: blocked events
 * ─────────────────────────────────────────────────────────────────────
 * These orchestrator event types indicate the framework is blocked and
 * waiting for the operator:
 *   - `OrchestratorBlockedByDor`
 *   - `OrchestratorBlockedByDependency`
 *   - `OrchestratorBlockedByDispatchability`
 *   - `OrchestratorBlockedByBlastRadiusOverlap`
 *   - `OrchestratorBlockedByOpenPullRequest`
 *   - `OrchestratorStuckCandidate`
 *
 * These event types indicate the operator took an action that unblocked
 * the pipeline:
 *   - `OrchestratorDispatched`    (operator approved dispatch)
 *   - `OrchestratorCompleted`     (task completed)
 *   - `OrchestratorRollback`      (operator triggered rollback)
 *
 * A "block span" starts on the first blocked event for a taskId and ends
 * on the first action event for the same taskId. The cost is the AFK-
 * filtered elapsed time of the span.
 *
 * @module tui/analytics/operator-time-cost
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  getFatigueStatus,
  loadDecisionsConfig,
  resolveDecisionsConfig,
} from '../../decisions/index.js';
import { resolveArtifactsDir } from '../sources/types.js';
import {
  DEFAULT_OPERATOR_TIME_COST_AFK_MINUTES,
  loadQualityMonitoringConfig,
  type OperatorTimeCostConfig,
} from './quality-monitoring-config.js';

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Orchestrator event types that mark the start of a block (operator must act).
 */
export const BLOCKED_EVENT_TYPES = new Set([
  'OrchestratorBlockedByDor',
  'OrchestratorBlockedByDependency',
  'OrchestratorBlockedByDispatchability',
  'OrchestratorBlockedByBlastRadiusOverlap',
  'OrchestratorBlockedByOpenPullRequest',
  'OrchestratorStuckCandidate',
]);

/**
 * Orchestrator event types that mark the end of a block (operator acted).
 */
export const ACTION_EVENT_TYPES = new Set([
  'OrchestratorDispatched',
  'OrchestratorCompleted',
  'OrchestratorRollback',
]);

/**
 * A single operator-time-cost measurement for a given (taskId, block) pair.
 */
export interface OperatorTimeCostEntry {
  /** Task ID the block was associated with. */
  taskId: string;
  /** ISO-8601 timestamp of the first blocked event. */
  blockedAt: string;
  /**
   * ISO-8601 timestamp of the first operator-action event.
   * `null` when the block has not yet been resolved.
   */
  resolvedAt: string | null;
  /**
   * Total wall-clock elapsed ms (resolvedAt - blockedAt).
   * `null` when unresolved.
   */
  wallClockMs: number | null;
  /**
   * Active operator cost ms — same as wallClockMs but with AFK gaps
   * (gaps > `afkInactivityMs`) zeroed out.
   *
   * This is the primary signal for the §7 severity rubric. Null when
   * the block has not yet been resolved.
   */
  activeCostMs: number | null;
  /**
   * The blocking event type that opened this span (e.g. `'OrchestratorBlockedByDor'`).
   */
  blockEventType: string;
  /**
   * The action event type that closed this span, or null when unresolved.
   */
  actionEventType: string | null;
}

/**
 * Aggregate operator-time-cost metrics across all measured blocks.
 */
export interface OperatorTimeCostMetrics {
  /**
   * Per-block measurements (resolved + unresolved). Sorted by `blockedAt`
   * ascending.
   */
  entries: OperatorTimeCostEntry[];
  /**
   * Mean active-cost ms across RESOLVED entries.
   * Null when no resolved entries exist.
   */
  meanActiveCostMs: number | null;
  /**
   * Qualitative §7.1 bucket derived from `meanActiveCostMs`:
   *   - `'high'`   — mean active cost ≥ 30 minutes
   *   - `'medium'` — mean active cost ≥ 5 minutes
   *   - `'low'`    — mean active cost < 5 minutes or no data
   *
   * This is the value that feeds into `computeSeverity(axes)`.
   */
  operatorTimeCostBucket: 'high' | 'medium' | 'low';
  /**
   * Number of resolved block entries included in the mean.
   */
  resolvedCount: number;
  /**
   * Number of unresolved block entries (operator has not yet acted).
   */
  unresolvedCount: number;
  /**
   * RFC-0035 §7 fatigue-signal composition (OQ-9 + AISDLC-291).
   *
   * - `false` — no fatigue signal active (default; pre-AISDLC-291 callers
   *   that don't pass `workDir` also see `false`).
   * - `true`  — operator has declared explicit fatigue via
   *   `cli-decisions fatigue set` (or the inferred-fatigue gate fires when
   *   `decisions-config.yaml: fatigue.inferFromBehavior` is opted in).
   *
   * Phase 7 wiring: when `workDir` is provided, the fatigue state at
   * `<workDir>/.ai-sdlc/operator-state.yaml` is read and surfaced here.
   * The §7 severity rubric formatter (`formatOperatorTimeCostForRubric`)
   * appends an `[RFC-0035 §7 fatigue: active]` note when this is `true`
   * and the prior gated note when `false` for forward-compat with the
   * existing test corpus.
   */
  rfc0035FatigueSignal: boolean;
}

// ── Options ───────────────────────────────────────────────────────────

export interface ComputeOperatorTimeCostOpts {
  artifactsDir?: string;
  /**
   * AFK inactivity threshold in minutes. Gaps between consecutive events
   * within a block span that exceed this threshold are excluded from the
   * active-cost computation. Default `30` per §13.1 / OQ-9 resolution.
   *
   * When omitted AND `workDir` is provided, the value is loaded from
   * `<workDir>/.ai-sdlc/quality-monitoring.yaml` (`quality.operator-time-cost.afkInactivityMinutes`).
   * Otherwise falls back to {@link DEFAULT_OPERATOR_TIME_COST_AFK_MINUTES}.
   */
  afkInactivityMinutes?: number;
  /**
   * Project root used to resolve per-org `quality-monitoring.yaml`
   * defaults when `afkInactivityMinutes` is not provided explicitly.
   * Defaults to `process.cwd()`.
   */
  workDir?: string;
  /**
   * Wall-clock override for "now". When provided, unresolved blocks
   * treat this as the resolution timestamp for wall-clock computation.
   * Defaults to `new Date()`.
   */
  now?: () => Date;
  /**
   * Restrict the computation to events for a specific taskId. When omitted,
   * all tasks in the events corpus are included.
   */
  taskId?: string;
}

/**
 * Resolve the AFK inactivity minutes for an operator-time-cost computation.
 * Precedence: explicit opts.afkInactivityMinutes > per-org yaml > default.
 *
 * Exported so callers (e.g. the orchestrator loop) can read the same
 * effective value when emitting telemetry, without having to duplicate
 * the load-and-default logic.
 */
export function resolveAfkInactivityMinutes(
  opts: Pick<ComputeOperatorTimeCostOpts, 'afkInactivityMinutes' | 'workDir'>,
): number {
  if (typeof opts.afkInactivityMinutes === 'number' && Number.isFinite(opts.afkInactivityMinutes)) {
    return opts.afkInactivityMinutes;
  }
  if (opts.workDir) {
    try {
      const cfg: OperatorTimeCostConfig = loadQualityMonitoringConfig({
        workDir: opts.workDir,
      }).operatorTimeCost;
      return cfg.afkInactivityMinutes;
    } catch {
      // QualityMonitoringConfigError or any other load failure → fall back
      // to the shipping default. The operator-time-cost metric must never
      // crash the orchestrator hot loop.
    }
  }
  return DEFAULT_OPERATOR_TIME_COST_AFK_MINUTES;
}

// ── Internal event shape (structural, tolerant) ───────────────────────

interface RawEvent {
  ts?: unknown;
  type?: unknown;
  taskId?: unknown;
}

// ── Computation ───────────────────────────────────────────────────────

/**
 * Read all events from `$ARTIFACTS_DIR/_orchestrator/events-*.jsonl` files,
 * sorted ascending by `ts`.
 *
 * Best-effort: malformed lines are silently skipped.
 */
function readAllEvents(artifactsDir: string): RawEvent[] {
  const dir = join(artifactsDir, '_orchestrator');
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    return [];
  }
  files.sort(); // chronological (YYYY-MM-DD sort)

  const events: RawEvent[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as RawEvent;
        if (parsed && typeof parsed.ts === 'string' && typeof parsed.type === 'string') {
          events.push(parsed);
        }
      } catch {
        // tolerate malformed lines
      }
    }
  }
  // Sort ascending by ts (files are chronological but events within a file
  // may have slightly out-of-order timestamps due to clock skew)
  events.sort((a, b) => {
    const aTs = typeof a.ts === 'string' ? a.ts : '';
    const bTs = typeof b.ts === 'string' ? b.ts : '';
    return aTs.localeCompare(bTs);
  });
  return events;
}

/**
 * Compute the AFK-filtered active cost for a span between two timestamps,
 * given a sorted list of all events that occurred within that span for the
 * same taskId.
 *
 * The AFK filter zeroes out any single gap between consecutive events that
 * exceeds `afkInactivityMs`. The remaining active intervals are summed.
 *
 * When there are no intermediate events, the gap between `spanStartMs` and
 * `spanEndMs` is treated as a single interval and filtered the same way.
 */
function computeActiveCostMs(
  spanStartMs: number,
  spanEndMs: number,
  intermediateEventTsMs: number[],
  afkInactivityMs: number,
): number {
  // Build a sorted list of all boundary points within the span
  const points = [spanStartMs, ...intermediateEventTsMs, spanEndMs].sort((a, b) => a - b);

  let activeCost = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const intervalMs = (points[i + 1] ?? 0) - (points[i] ?? 0);
    if (intervalMs <= afkInactivityMs) {
      activeCost += intervalMs;
    }
    // If intervalMs > afkInactivityMs, it's an AFK gap — add zero.
  }
  return activeCost;
}

/**
 * Classify the mean active-cost ms into a §7.1 qualitative bucket.
 *
 * Thresholds:
 *   - `'high'`   — ≥ 30 minutes (1,800,000 ms)
 *   - `'medium'` — ≥ 5 minutes  (300,000 ms)
 *   - `'low'`    — < 5 minutes
 */
export function classifyActiveCostBucket(
  meanActiveCostMs: number | null,
): 'high' | 'medium' | 'low' {
  if (meanActiveCostMs === null) return 'low';
  const HIGH_THRESHOLD_MS = 30 * 60 * 1000; // 30 min
  const MEDIUM_THRESHOLD_MS = 5 * 60 * 1000; // 5 min
  if (meanActiveCostMs >= HIGH_THRESHOLD_MS) return 'high';
  if (meanActiveCostMs >= MEDIUM_THRESHOLD_MS) return 'medium';
  return 'low';
}

/**
 * Compute instrumented operator-time-cost from the RFC-0015 events.jsonl
 * substrate.
 *
 * For each (taskId, block-span) pair:
 *   1. Find the first `OrchestratorBlockedByX` event → `blockedAt`.
 *   2. Find the next `OrchestratorDispatched / Completed / Rollback` event
 *      for the same taskId → `resolvedAt`.
 *   3. Compute `wallClockMs = resolvedAt - blockedAt`.
 *   4. Compute `activeCostMs = wallClockMs` with AFK gaps filtered out.
 *
 * Emits the RFC-0035 §7 fatigue-signal gate at `rfc0035FatigueSignal: false`
 * (gated until RFC-0035 Phase 7 / AISDLC-291 ships).
 */
export function computeOperatorTimeCost(
  opts: ComputeOperatorTimeCostOpts = {},
): OperatorTimeCostMetrics {
  const artifactsDir = resolveArtifactsDir({ artifactsDir: opts.artifactsDir });
  const afkInactivityMinutes = resolveAfkInactivityMinutes({
    afkInactivityMinutes: opts.afkInactivityMinutes,
    workDir: opts.workDir,
  });
  const afkInactivityMs = afkInactivityMinutes * 60 * 1000;

  const allEvents = readAllEvents(artifactsDir);

  // Group events by taskId (filter by opts.taskId when provided)
  const eventsByTask = new Map<string, RawEvent[]>();
  for (const event of allEvents) {
    if (typeof event.taskId !== 'string' || !event.taskId) continue;
    if (opts.taskId && event.taskId !== opts.taskId) continue;
    const list = eventsByTask.get(event.taskId) ?? [];
    list.push(event);
    eventsByTask.set(event.taskId, list);
  }

  const entries: OperatorTimeCostEntry[] = [];

  for (const [taskId, taskEvents] of eventsByTask.entries()) {
    // Walk events in order, looking for blocked-then-action spans
    let blockStart: RawEvent | null = null;

    for (const event of taskEvents) {
      const type = event.type as string;

      if (!blockStart) {
        // Looking for a blocked event
        if (BLOCKED_EVENT_TYPES.has(type)) {
          blockStart = event;
        }
        continue;
      }

      // Inside a block span — looking for an action event
      if (ACTION_EVENT_TYPES.has(type)) {
        // Block resolved
        const blockedAtTs = blockStart.ts as string;
        const resolvedAtTs = event.ts as string;
        const blockedAtMs = new Date(blockedAtTs).getTime();
        const resolvedAtMs = new Date(resolvedAtTs).getTime();

        let wallClockMs: number | null = null;
        let activeCostMs: number | null = null;

        if (
          !Number.isNaN(blockedAtMs) &&
          !Number.isNaN(resolvedAtMs) &&
          resolvedAtMs >= blockedAtMs
        ) {
          wallClockMs = resolvedAtMs - blockedAtMs;

          // Collect intermediate event timestamps within the span (same taskId)
          const intermediates = taskEvents
            .filter((e) => {
              if (typeof e.ts !== 'string') return false;
              const ms = new Date(e.ts).getTime();
              return ms > blockedAtMs && ms < resolvedAtMs;
            })
            .map((e) => new Date(e.ts as string).getTime());

          activeCostMs = computeActiveCostMs(
            blockedAtMs,
            resolvedAtMs,
            intermediates,
            afkInactivityMs,
          );
        }

        entries.push({
          taskId,
          blockedAt: blockedAtTs,
          resolvedAt: resolvedAtTs,
          wallClockMs,
          activeCostMs,
          blockEventType: blockStart.type as string,
          actionEventType: type,
        });

        // Reset — look for next block span
        blockStart = null;
      }
      // If still blocked (more blocked events), keep blockStart as the FIRST one
    }

    // If a block is still open (no action event found), emit an unresolved entry
    if (blockStart) {
      entries.push({
        taskId,
        blockedAt: blockStart.ts as string,
        resolvedAt: null,
        wallClockMs: null,
        activeCostMs: null,
        blockEventType: blockStart.type as string,
        actionEventType: null,
      });
    }
  }

  // Sort by blockedAt ascending
  entries.sort((a, b) => a.blockedAt.localeCompare(b.blockedAt));

  // Compute aggregate metrics
  const resolvedEntries = entries.filter((e) => e.activeCostMs !== null);
  const unresolvedCount = entries.length - resolvedEntries.length;

  const meanActiveCostMs =
    resolvedEntries.length === 0
      ? null
      : Math.round(
          resolvedEntries.reduce((sum, e) => sum + (e.activeCostMs ?? 0), 0) /
            resolvedEntries.length,
        );

  const operatorTimeCostBucket = classifyActiveCostBucket(meanActiveCostMs);

  // RFC-0035 §7 fatigue-signal composition (AISDLC-291). When `workDir` is
  // available, read the operator-state and decisions-config so the §7
  // severity rubric can colour the output by fatigue status. Best-effort:
  // any read failure (missing config, parse errors) degrades to `false`.
  let rfc0035FatigueSignal = false;
  if (opts.workDir) {
    try {
      const cfg = resolveDecisionsConfig(loadDecisionsConfig({ workDir: opts.workDir }));
      rfc0035FatigueSignal = getFatigueStatus(opts.workDir, { config: cfg.fatigue }).active;
    } catch {
      // The operator-time-cost metric must never crash the hot loop —
      // a missing or unreadable operator-state is treated as "not fatigued".
      rfc0035FatigueSignal = false;
    }
  }

  return {
    entries,
    meanActiveCostMs,
    operatorTimeCostBucket,
    resolvedCount: resolvedEntries.length,
    unresolvedCount,
    rfc0035FatigueSignal,
  };
}

// ── §7 severity rubric integration ────────────────────────────────────

/**
 * Format the operator-time-cost bucket for §7 severity rubric output.
 *
 * Returns a human-readable line for inclusion in the severity rubric
 * display. The RFC-0035 §7 fatigue-signal note is appended (gated).
 *
 * Example: `"Operator time cost: medium (mean active: 8m 23s)"`
 */
export function formatOperatorTimeCostForRubric(metrics: OperatorTimeCostMetrics): string {
  const bucketLabel = metrics.operatorTimeCostBucket;
  const meanPart =
    metrics.meanActiveCostMs !== null
      ? ` (mean active: ${formatDurationMs(metrics.meanActiveCostMs)})`
      : ' (no data)';
  // Phase 7 (AISDLC-291) flipped the seam: `rfc0035FatigueSignal` is now a
  // real boolean. When the operator declares fatigue (or the opt-in
  // inferred-fatigue gate fires) the note shows "active" so the operator
  // sees their declaration honoured downstream; otherwise it shows
  // "inactive" rather than the pre-AISDLC-291 "gated" wording.
  const note = metrics.rfc0035FatigueSignal
    ? ' [RFC-0035 §7 fatigue-signal: active]'
    : ' [RFC-0035 §7 fatigue-signal: inactive]';
  return `Operator time cost: ${bucketLabel}${meanPart}${note}`;
}

/**
 * Format a duration in milliseconds to a compact human-readable string.
 * Examples: `"30s"`, `"2m 15s"`, `"1h 5m"`.
 */
function formatDurationMs(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}
