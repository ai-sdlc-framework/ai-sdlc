/**
 * Metric computation for the Analytics pane (RFC-0023 §10 / OQ-3 /
 * AISDLC-178.6).
 *
 * Pure functions — no I/O. Input is the raw data sources (decisions,
 * pr-decisions, events, backlog tasks, reliability trend); output is the
 * shaped numbers + labels the pane renders. Splits cleanly into:
 *   - `computeOperatorMetrics()` — operator-throughput section (PRIMARY,
 *     top of pane per OQ-3).
 *   - `computePipelineMetrics()` — pipeline-throughput section
 *     (SECONDARY, below the divider).
 *
 * The reliability-trend metric (RFC-0025) is part of pipeline metrics —
 * `computePipelineMetrics` reads it but treats the `available: false`
 * sentinel as "no data" so the pane degrades gracefully (AC#8).
 */

import type { OrchestratorEvent } from '../../orchestrator/events.js';
import type { BacklogTask } from '../sources/backlog-walker.js';
import type { DecisionRecord } from './decisions-writer.js';
import { NEEDS_CLARIFICATION_STATUS } from './decisions-writer.js';
import type { ReliabilityTrend } from './quality-reader.js';

export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
/** "Stale" threshold — clarifications older than 72h are user-attention overdue. */
export const STALE_CLARIFICATION_THRESHOLD_MS = 72 * 60 * 60 * 1000;

// ── Operator throughput ────────────────────────────────────────────────

export interface OperatorMetrics {
  /** Decisions resolved in the last 24h. */
  decisionsResolved24h: number;
  /** Average time-to-decision across last-24h resolutions, ms. Null when 0 resolutions. */
  avgTimeToDecisionMs: number | null;
  /**
   * % of WIP currently waiting on the operator. WIP = tasks with status
   * `In Progress`, `Needs Clarification`, or any `Review*` flavour. Numerator
   * is the Needs-Clarification slice. Returns 0 when WIP=0.
   */
  pctWipBlockedOnOperator: number;
  /** Count of Needs Clarification entries older than STALE_CLARIFICATION_THRESHOLD_MS. */
  staleCapturesCount: number;
}

export interface ComputeOperatorMetricsOpts {
  /** "Now" reference for the 24h window + stale threshold. Defaults `new Date()`. */
  now?: Date;
}

const WIP_STATUSES = new Set([
  'In Progress',
  'Needs Clarification',
  'In Review',
  'Review',
  'Reviewing',
]);

export function computeOperatorMetrics(
  decisions: ReadonlyArray<DecisionRecord>,
  tasks: ReadonlyArray<BacklogTask>,
  opts: ComputeOperatorMetricsOpts = {},
): OperatorMetrics {
  const now = (opts.now ?? new Date()).getTime();
  const cutoff = now - TWENTY_FOUR_HOURS_MS;

  // Decisions resolved in the last 24h.
  let resolved24h = 0;
  let durationSumMs = 0;
  for (const record of decisions) {
    const tsMs = new Date(record.ts).getTime();
    if (Number.isNaN(tsMs)) continue;
    if (tsMs >= cutoff && tsMs <= now) {
      resolved24h += 1;
      durationSumMs += Math.max(0, record.durationMs);
    }
  }

  const avgTimeToDecisionMs = resolved24h > 0 ? Math.round(durationSumMs / resolved24h) : null;

  // % WIP blocked on operator + stale captures.
  let wipCount = 0;
  let needsClarification = 0;
  let staleCount = 0;
  for (const task of tasks) {
    if (task.fileLocation !== 'open') continue;
    if (!WIP_STATUSES.has(task.status)) continue;
    wipCount += 1;
    if (task.status !== NEEDS_CLARIFICATION_STATUS) continue;
    needsClarification += 1;
    if (!task.lastModified) continue;
    const ageMs = now - new Date(task.lastModified).getTime();
    if (Number.isNaN(ageMs)) continue;
    if (ageMs >= STALE_CLARIFICATION_THRESHOLD_MS) staleCount += 1;
  }

  const pct = wipCount > 0 ? Math.round((needsClarification / wipCount) * 100) : 0;

  return {
    decisionsResolved24h: resolved24h,
    avgTimeToDecisionMs,
    pctWipBlockedOnOperator: pct,
    staleCapturesCount: staleCount,
  };
}

// ── Pipeline throughput ────────────────────────────────────────────────

export interface PipelineMetrics {
  dispatched24h: number;
  merged24h: number;
  failed24h: number;
  quarantined24h: number;
  /** Reliability trend pass-through. `available: false` ⇒ pane shows "no data". */
  reliability: ReliabilityTrend;
}

export interface ComputePipelineMetricsOpts {
  now?: Date;
}

/**
 * Roll up pipeline-throughput counters from the orchestrator events
 * stream. Counters are simple `event.type` tallies in the 24h window —
 * intentionally small — the operator wants direction, not precision.
 *
 * `quarantined` = `OrchestratorWorkQuarantined` events (the explicit
 * "we couldn't recover this branch" signal AISDLC-177 ships).
 */
export function computePipelineMetrics(
  events: ReadonlyArray<OrchestratorEvent>,
  reliability: ReliabilityTrend,
  opts: ComputePipelineMetricsOpts = {},
): PipelineMetrics {
  const now = (opts.now ?? new Date()).getTime();
  const cutoff = now - TWENTY_FOUR_HOURS_MS;

  let dispatched = 0;
  let merged = 0;
  let failed = 0;
  let quarantined = 0;

  for (const ev of events) {
    if (typeof ev.ts !== 'string') continue;
    const tsMs = new Date(ev.ts).getTime();
    if (Number.isNaN(tsMs) || tsMs < cutoff || tsMs > now) continue;

    switch (ev.type) {
      case 'OrchestratorDispatched':
        dispatched += 1;
        break;
      case 'OrchestratorCompleted':
        merged += 1;
        break;
      case 'OrchestratorFailed':
        failed += 1;
        break;
      case 'OrchestratorWorkQuarantined':
        quarantined += 1;
        break;
      default:
        break;
    }
  }

  return {
    dispatched24h: dispatched,
    merged24h: merged,
    failed24h: failed,
    quarantined24h: quarantined,
    reliability,
  };
}

// ── Formatters ────────────────────────────────────────────────────────

/**
 * Format a millisecond duration as a human-readable label
 * (`12m`, `3.4h`, `2.1d`). Used by the pane to render the
 * `avg time-to-decision` figure compactly. Returns `'—'` for `null`.
 */
export function formatDurationCompact(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

/**
 * Format a reliability trend as the "Δ X (vs Y last week)" label the
 * pane renders. Returns `'no data'` when `reliability.available` is
 * false — that's the AC#8 graceful-degradation path.
 */
export function formatReliabilityTrend(reliability: ReliabilityTrend): string {
  if (!reliability.available) return 'no data';
  const arrow = reliability.delta < 0 ? '↓' : reliability.delta > 0 ? '↑' : '→';
  const sign = reliability.delta > 0 ? '+' : '';
  return `${reliability.thisWeek} captures ${arrow} ${sign}${reliability.delta} vs ${reliability.lastWeek} last week`;
}
