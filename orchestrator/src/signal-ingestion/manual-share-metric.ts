/**
 * RFC-0030 OQ-13.4 v0.3 re-walkthrough — manual-share quality metric.
 *
 * Tracks the rolling `manualSignals / totalSignals` ratio over a configurable
 * window (default 7d). When the share exceeds the configured threshold
 * (default 0.30) on a population that's large enough to be meaningful, emit
 * `Decision: manual-signal-share-elevated` — a WARNING (not a block) that
 * the pipeline is acting as a data-entry tool rather than automated
 * demand-detection (architectural anti-pattern).
 *
 * Design decisions:
 *  - Window is computed against `asOf` (defaults to `new Date()`) so tests
 *    can drive a deterministic clock.
 *  - Signals are bucketed by `sourceTimestamp` (NOT receipt time); this
 *    matches the spirit of the metric ("what fraction of recent SOURCE
 *    activity was manual"). Operator-attested manual signals carry their
 *    sourceTimestamp = observation time, so the bucketing is honest.
 *  - When `totalSignals == 0` over the window, returns `manualShare: 0` and
 *    `elevated: false` (no division-by-zero, no false alarms on empty windows).
 *  - The metric does NOT mutate signals — it observes a population and
 *    returns a verdict. Caller (typically the pipeline orchestrator step
 *    that wires Phase 4 outputs) emits the Decision when `elevated` is true.
 */

import type { ManualSignalShareElevatedDecision, RawSignal, SignalSourceName } from './types.js';

/** Default window (rolling) over which the manual-share ratio is computed. */
export const DEFAULT_MANUAL_SHARE_WINDOW_DAYS = 7;

/** Default warning threshold (manual / total) above which the Decision fires. */
export const DEFAULT_MANUAL_SHARE_WARNING_THRESHOLD = 0.3;

/**
 * Minimum total-signals count before we'll fire the elevated Decision.
 * Prevents thrashing on tiny populations (1 manual + 1 total = 100% share
 * fires spuriously). Tunable per-deployment if the framework default doesn't
 * fit.
 */
export const DEFAULT_MANUAL_SHARE_MIN_POPULATION = 5;

/**
 * Per-signal source classifier: returns `true` when the signal came from a
 * manual-entry adapter. The check is name-based to keep the helper
 * decoupled from the `ManualSignalSourceAdapter` class — sources are
 * identified by their `SignalSourceName`, and `signal-source-manual` is the
 * canonical name.
 *
 * Tests can pass a custom predicate via `ManualShareMetricOptions.isManual`
 * when modelling derivative manual-entry adapters.
 */
export function defaultIsManualSignal(signal: RawSignal): boolean {
  const adapterName = signal.metadata?.['adapterName'] as SignalSourceName | undefined;
  if (adapterName === 'signal-source-manual') return true;
  // Heuristic fallback: presence of `attestedBy` is the structural signature
  // of a manual-entered signal even when metadata is missing the adapterName.
  return typeof signal.attestedBy === 'string' && signal.attestedBy.trim().length > 0;
}

/** Inputs for `computeManualShareMetric()`. */
export interface ManualShareMetricOptions {
  /** Rolling window in days. Defaults to `DEFAULT_MANUAL_SHARE_WINDOW_DAYS` (7). */
  windowDays?: number;
  /** Warning threshold. Defaults to `DEFAULT_MANUAL_SHARE_WARNING_THRESHOLD` (0.30). */
  shareWarningThreshold?: number;
  /** Reference time for the rolling window. Defaults to `new Date()`. */
  asOf?: Date;
  /**
   * Minimum total-signal count required before the elevated Decision can
   * fire. Defaults to `DEFAULT_MANUAL_SHARE_MIN_POPULATION` (5). Prevents
   * spurious alarms on tiny populations.
   */
  minPopulation?: number;
  /** Override the manual-signal classifier. Defaults to `defaultIsManualSignal`. */
  isManual?: (signal: RawSignal) => boolean;
}

/** Result of `computeManualShareMetric()`. */
export interface ManualShareMetricResult {
  /** Rolling manual / total ratio over the window. `0` when totalSignals is 0. */
  manualShare: number;
  /** Number of manual signals in the window. */
  manualSignals: number;
  /** Total number of signals in the window. */
  totalSignals: number;
  /** The window the metric was computed over (in days). */
  windowDays: number;
  /** Whether the elevated Decision should fire. */
  elevated: boolean;
  /**
   * The Decision record, populated IFF `elevated` is `true`. Caller can
   * forward this directly into the catalog without re-constructing the
   * envelope.
   */
  decision?: ManualSignalShareElevatedDecision;
}

/**
 * Compute the rolling manual-share metric on the supplied signal population.
 *
 * Bucketing rule: a signal is in the window IFF
 *   `signal.sourceTimestamp >= asOf - windowDays`.
 *
 * The result is suitable for streaming back to the operator as a quality
 * signal AND for forwarding to the RFC-0035 catalog when `elevated` fires.
 */
export function computeManualShareMetric(
  signals: readonly RawSignal[],
  options: ManualShareMetricOptions = {},
): ManualShareMetricResult {
  const windowDays = options.windowDays ?? DEFAULT_MANUAL_SHARE_WINDOW_DAYS;
  const threshold = options.shareWarningThreshold ?? DEFAULT_MANUAL_SHARE_WARNING_THRESHOLD;
  const asOf = options.asOf ?? new Date();
  const minPopulation = options.minPopulation ?? DEFAULT_MANUAL_SHARE_MIN_POPULATION;
  const isManual = options.isManual ?? defaultIsManualSignal;

  const windowStart = new Date(asOf.getTime() - windowDays * 24 * 60 * 60 * 1000);

  let manualCount = 0;
  let totalCount = 0;
  for (const s of signals) {
    if (s.sourceTimestamp < windowStart) continue;
    if (s.sourceTimestamp > asOf) continue;
    totalCount += 1;
    if (isManual(s)) manualCount += 1;
  }

  const manualShare = totalCount === 0 ? 0 : manualCount / totalCount;
  const elevated = totalCount >= minPopulation && manualShare > threshold;

  const result: ManualShareMetricResult = {
    manualShare,
    manualSignals: manualCount,
    totalSignals: totalCount,
    windowDays,
    elevated,
  };

  if (elevated) {
    result.decision = {
      type: 'Decision',
      decision: 'manual-signal-share-elevated',
      manualShare,
      threshold,
      windowDays,
      manualSignals: manualCount,
      totalSignals: totalCount,
      message:
        `Manual signal share elevated: ${(manualShare * 100).toFixed(1)}% over ` +
        `last ${windowDays}d (${manualCount}/${totalCount}); threshold is ${(threshold * 100).toFixed(0)}%. ` +
        `This may indicate the pipeline is being used as a data-entry tool rather than automated ` +
        `demand-detection. Review adapter coverage + automation gaps.`,
    };
  }

  return result;
}
