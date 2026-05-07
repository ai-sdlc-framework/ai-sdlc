/**
 * Composite hook backing the Analytics pane (RFC-0023 §10 / AISDLC-178.6).
 *
 * Wires the existing TUI data sources (events tail, backlog walker) plus
 * the new readers (decisions, reliability trend) into the metric
 * computations the pane renders. Each underlying source is independently
 * pollable; this hook just snapshots them on each render.
 *
 * Tests inject `fetcher` overrides to drive the metrics deterministically
 * without filesystem access.
 */

import { useEffect, useState } from 'react';

import type { OrchestratorEvent } from '../../orchestrator/events.js';
import type { BacklogTask } from '../sources/backlog-walker.js';
import { readDecisions, type ReadDecisionsResult } from './decisions-reader.js';
import { readReliabilityTrend, type ReliabilityTrend } from './quality-reader.js';
import {
  computeOperatorMetrics,
  computePipelineMetrics,
  type OperatorMetrics,
  type PipelineMetrics,
} from './metrics.js';

/** Default poll cadence for the analytics readers (matches RFC §6.2 events tail). */
export const ANALYTICS_POLL_INTERVAL_MS = 5_000;

export interface AnalyticsSnapshot {
  operator: OperatorMetrics;
  pipeline: PipelineMetrics;
  /** True when no data has been seen on any source. Drives the empty-state copy. */
  empty: boolean;
}

export interface UseAnalyticsOpts {
  intervalMs?: number;
  /** Tests: provide each source's snapshot directly. */
  events?: ReadonlyArray<OrchestratorEvent>;
  tasks?: ReadonlyArray<BacklogTask>;
  /** Tests: override the decisions reader. */
  decisionsReader?: () => ReadDecisionsResult;
  /** Tests: override the reliability-trend reader. */
  reliabilityReader?: () => ReliabilityTrend;
  /** Tests: override "now". */
  now?: () => Date;
  /** Override artifacts dir for the production readers. */
  artifactsDir?: string;
}

/**
 * Tiny hook — recomputes the metrics whenever the `intervalMs` timer
 * fires or the (test-injected) data inputs change. Production callers
 * pass nothing; tests pass `events` + `tasks` directly + override the
 * readers so the I/O layer is bypassed.
 */
export function useAnalytics(opts: UseAnalyticsOpts = {}): AnalyticsSnapshot {
  const intervalMs = opts.intervalMs ?? ANALYTICS_POLL_INTERVAL_MS;
  const events = opts.events ?? [];
  const tasks = opts.tasks ?? [];
  const decisionsReader =
    opts.decisionsReader ??
    ((): ReadDecisionsResult => readDecisions({ artifactsDir: opts.artifactsDir }));
  const reliabilityReader =
    opts.reliabilityReader ??
    ((): ReliabilityTrend => readReliabilityTrend({ artifactsDir: opts.artifactsDir }));
  const now = opts.now ?? ((): Date => new Date());

  // The polling timer just nudges a counter so the consumer pane re-
  // renders; the actual computation runs every render below (cheap —
  // small JSONL reads + a few `for` loops).
  const [, setTick] = useState(0);

  useEffect(() => {
    const handle = setInterval(() => setTick((n) => n + 1), intervalMs);
    return (): void => clearInterval(handle);
  }, [intervalMs]);

  const decisions = decisionsReader().records;
  const reliability = reliabilityReader();
  const nowDate = now();
  const operator = computeOperatorMetrics(decisions, tasks, { now: nowDate });
  const pipeline = computePipelineMetrics(events, reliability, { now: nowDate });
  const empty =
    decisions.length === 0 &&
    events.length === 0 &&
    operator.decisionsResolved24h === 0 &&
    operator.staleCapturesCount === 0 &&
    pipeline.dispatched24h === 0 &&
    pipeline.merged24h === 0 &&
    pipeline.failed24h === 0 &&
    pipeline.quarantined24h === 0;
  return { operator, pipeline, empty };
}
