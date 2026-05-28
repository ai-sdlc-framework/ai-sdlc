/**
 * RFC-0030 Phase 4 — Tier 2 significance threshold, SA resonance filter,
 * flooding detection (z-score on rolling per-source baseline), residency-
 * violation gate.
 *
 * This module operates on Phase 3 `DemandCluster[]` output and produces:
 *
 *   1. **Tier 2 significance gate** (RFC-0030 §8): clusters must meet
 *      `minSignalCount` + `minUniqueSources` + `minTier1SignalCount` +
 *      `minClusterAgeDays` before they qualify for D1 scoring. Below-threshold
 *      clusters are marked `monitored` (not silently dropped — they remain
 *      visible for operator review).
 *
 *   2. **SA resonance filter** (RFC-0030 §9 + RFC-0029 Principle 4): clusters
 *      are bucketed by SA resonance score against the current Soul DID:
 *        - `>= fullWeight`           → `full`        (no D1 weight discount)
 *        - `>= discounted`           → `discounted`  (D1 weight × 0.7)
 *        - `>= excluded` (exclusive) → `low-sa-review` (D1 weight × 0.3 +
 *          Decision logged for Product Lead batch review per AC #3)
 *        - `<= excluded` (== 0.0)    → `out-of-scope` (excluded from D1;
 *          logged as out-of-scope demand)
 *
 *   3. **OQ-13.5 flooding detection (AISDLC-433 v0.3 refinement)** — REPLACES
 *      the previous fixed-multiplier detector with z-score on the same
 *      per-source rolling baseline:
 *        - For every source in the detection window, compute its
 *          `windowCount` (signals in the last `windowMinutes`) and compare
 *          to the per-source baseline `{mean, stddev}` computed from the
 *          rolling `baselineDays`-day history.
 *        - Trigger condition (RFC-0030 §13.5):
 *            `windowCount > (mean + zScoreThreshold × stddev)`
 *            AND `uniqueSources_in_window < minUniqueSourcesForSuspicion`
 *          → emit `Decision: signal-flooding-detected`.
 *        - **Cold-start handling** (AC #4): when the rolling baseline has
 *          fewer than `baselineDays` of history, the detector returns the
 *          `calibrating` status and emits NO Decision — Tier 2 significance
 *          is the sole defense during the calibration window.
 *        - **Quarantine** (AC #6, #7): flooding signals are tagged
 *          `quarantined: true` with an `expiresAt` timestamp; quarantined
 *          signals do NOT feed D1 (D1 path filters them out). Default
 *          duration 24h; per-org `flooding.quarantineDurationHours`
 *          override. Auto-expiry releases signals back to D1 candidacy.
 *        - **Operator one-click unquarantine** (AC #8, #9): the surface
 *          composes with RFC-0023 Blockers pane via the `QuarantineStore`
 *          API + the `unquarantineFlooded()` helper. Unquarantine emits
 *          `Decision: signal-flooding-false-positive` referencing the
 *          original flooding Decision (feedback signal for v2
 *          reputation-weighting calibration).
 *      Pipeline NEVER halts on flooding (G0 non-blocking contract).
 *
 *   4. **OQ-13.3 residency-violation gate** (adapter-level): per `checkSignalResidency`,
 *      a signal whose `region` falls outside the adopter's declared regime
 *      `allowedRegions` is refused at adapter level. Pipeline never halts.
 *
 * @module signal-ingestion/significance
 */

import type { DemandCluster } from './clustering.js';
import type {
  FloodingDetectionConfig,
  FloodingQuarantineConfig,
  SignalIngestionConfig,
  Tier2SignificanceThreshold,
  SaResonanceThresholds,
} from './config.js';
import { DEFAULT_SIGNAL_INGESTION_CONFIG } from './config.js';
import type { RawSignal, SignalResidencyViolationDecision, SignalSourceName } from './types.js';

// ── Public types ────────────────────────────────────────────────────────────

/**
 * Outcome of running the Tier 2 significance gate on a single cluster.
 *   - `qualified`  — meets all four threshold conditions; eligible for D1.
 *   - `monitored`  — at least one condition unmet; cluster persisted but
 *                    does NOT feed D1 (RFC-0030 §8).
 */
export type Tier2SignificanceState = 'qualified' | 'monitored';

/**
 * Which threshold conditions failed, when the cluster is `monitored`.
 * `[]` when the cluster is `qualified`.
 */
export interface Tier2SignificanceReasons {
  signalCount: boolean;
  uniqueSources: boolean;
  tier1SignalCount: boolean;
  clusterAgeDays: boolean;
}

/**
 * Per RFC-0030 §9: cluster SA resonance bucket. The bucket directly determines
 * the D1 weight multiplier (see `SA_WEIGHT_MULTIPLIERS`).
 *
 *   - `full`           — `saResonance >= fullWeight` (default 0.7). Full D1 weight.
 *   - `discounted`     — `>= discounted` (default 0.4) and `< fullWeight`.
 *                        D1 weight × 0.7.
 *   - `low-sa-review`  — `> excluded` (default 0.0, exclusive) and `< discounted`.
 *                        D1 weight × 0.3 + logged via Decision for Product Lead
 *                        batch review (AC #3).
 *   - `out-of-scope`   — `<= excluded` (default 0.0). Excluded from D1; logged
 *                        as out-of-scope demand for separate triage.
 *   - `pending`        — `cluster.saResonance` is `undefined` (Phase 3 default).
 *                        Caller must populate `saResonance` before invoking
 *                        the filter (typically via the Soul DID adapter); the
 *                        bucket reports `pending` and the cluster is excluded
 *                        from D1 by default (fail-closed).
 */
export type SaResonanceBucket =
  | 'full'
  | 'discounted'
  | 'low-sa-review'
  | 'out-of-scope'
  | 'pending';

/** Per-bucket D1 weight multiplier per RFC-0030 §9. */
export const SA_WEIGHT_MULTIPLIERS: Readonly<Record<SaResonanceBucket, number>> = Object.freeze({
  full: 1.0,
  discounted: 0.7,
  'low-sa-review': 0.3,
  'out-of-scope': 0.0,
  pending: 0.0,
});

/**
 * A `DemandCluster` annotated with its Phase 4 verdict on significance + SA.
 * The augmented record is what downstream Phase 5 D1 reformulation consumes.
 *
 * `eligibleForD1` is `true` IFF the cluster `qualified` for the significance
 * threshold AND its SA bucket is NOT `out-of-scope` / `pending`.
 *
 * `d1WeightMultiplier` is the combined product of:
 *   - significance flag (qualified → 1.0, monitored → 0.0)
 *   - SA bucket multiplier (per SA_WEIGHT_MULTIPLIERS)
 * Downstream Phase 5 multiplies this against the existing `baseWeight ×
 * tierMultiplier × icpResonanceWeight × recencyDecay` chain.
 */
export interface SignificanceAssessedCluster {
  cluster: DemandCluster;
  tier2Significance: Tier2SignificanceState;
  tier2Reasons: Tier2SignificanceReasons;
  saResonanceBucket: SaResonanceBucket;
  eligibleForD1: boolean;
  d1WeightMultiplier: number;
}

/**
 * Emitted when a cluster's SA resonance bucket is `low-sa-review` per AC #3 —
 * the demand is real but adjacent-to-soul, and Product Lead should review it
 * (NOT silently dropped). Routes via the RFC-0035 G0 catalog.
 */
export interface SignalLowSaForReviewDecision {
  type: 'Decision';
  decision: 'signal-low-sa-for-review';
  clusterId: string;
  saResonance: number;
  signalCount: number;
  message: string;
}

/**
 * Emitted when the SA bucket is `out-of-scope` (saResonance <= excluded
 * threshold, default 0.0). Per RFC-0030 §9 the demand is logged for separate
 * triage rather than fed into D1. Distinct from `low-sa-review` so operators
 * can prioritise reviewing soul-adjacent demand over fully-out-of-scope
 * demand.
 */
export interface SignalOutOfScopeDecision {
  type: 'Decision';
  decision: 'signal-out-of-scope';
  clusterId: string;
  saResonance: number;
  signalCount: number;
  message: string;
}

/**
 * Detection status returned by `detectFlooding()`.
 *   - `flooded`     — the trigger condition fired; a Decision was emitted.
 *   - `clean`       — detector ran, baseline sufficient, no trigger.
 *   - `calibrating` — rolling baseline has <`baselineDays` of history; no
 *                     Decisions emitted (Tier 2 significance is sole defense
 *                     during calibration). Per AC #4.
 *   - `empty-window`— the detection window contains zero signals.
 */
export type FloodingDetectionStatus = 'flooded' | 'clean' | 'calibrating' | 'empty-window';

/**
 * Z-score detector output for one detection window.
 *
 * `status` describes the outcome (cold-start / clean / flooded / empty).
 * `decision` is populated iff `status === 'flooded'`; it's the Decision the
 * caller routes to the RFC-0035 catalog.
 */
export interface FloodingDetectionResult {
  status: FloodingDetectionStatus;
  /** Populated when `status === 'flooded'`. */
  decision?: SignalFloodingDetectedDecision;
  /** Number of signals in the detection window. */
  signalCount: number;
  /** Distinct sources in the detection window. */
  uniqueSources: number;
  /** Days of baseline data the detector had access to. */
  baselineDaysObserved: number;
}

/**
 * Per-source baseline samples. Each entry is the daily signal-count
 * observation for that source over the rolling baseline window. The detector
 * computes `{mean, stddev}` from the samples.
 *
 * Operators wire this map from their historical-data substrate; persistence
 * is the caller's responsibility (orchestrator events.jsonl roll-up, etc.).
 * AISDLC-433 ships the detection algorithm; the substrate plumbing is the
 * caller's domain.
 */
export type PerSourceBaseline = Record<string, number[]>;

/**
 * Per-source baseline statistic. Internal — exposed for unit testing.
 */
export interface BaselineStat {
  /** Mean of the samples. */
  mean: number;
  /** Population standard deviation of the samples. */
  stddev: number;
  /** Number of samples (days observed). */
  sampleCount: number;
}

/**
 * Source-level flooding flag — surfaces in the Decision so the operator
 * sees which source tripped the trigger.
 */
export interface FloodingSourceFlag {
  /** Source identifier (adapter name when available, falls back to sourceId prefix). */
  sourceId: string;
  /** Z-score for this source's window count vs its baseline. */
  zScore: number;
  /** Window signal count. */
  windowCount: number;
  /** Baseline mean signals/day. */
  baselineMean: number;
  /** Baseline standard deviation signals/day. */
  baselineStddev: number;
  /** Days of baseline data observed for this source. */
  baselineDays: number;
}

/**
 * Decision emitted when the z-score detector trips per RFC-0030 §13.5
 * (AISDLC-433 v0.3 refinement). Replaces the legacy multi-indicator Decision.
 */
export interface SignalFloodingDetectedDecision {
  type: 'Decision';
  decision: 'signal-flooding-detected';
  /** Stable Decision ID — the operator unquarantine path references this. */
  decisionId: string;
  /** Detection-window cutoff used when this Decision was emitted. */
  detectedAt: string;
  /** Total signal count in the detection window. */
  signalCount: number;
  /** Number of distinct sources contributing to the window. */
  uniqueSources: number;
  /** Per-source z-scores + baseline stats for sources that exceeded threshold. */
  flaggedSources: FloodingSourceFlag[];
  /** Source IDs of signals quarantined as a result of this Decision (empty when quarantine disabled). */
  quarantinedSourceIds: string[];
  /** Quarantine duration applied (hours; 0 when disabled). */
  quarantineDurationHours: number;
  message: string;
}

/**
 * Re-export of the live default for back-compat with the previous shipped
 * surface. Phase 4 originally exposed `DEFAULT_FLOODING_DETECTION_CONFIG`
 * as a frozen object; AISDLC-433 routes the same name to the v0.3 z-score
 * defaults (sourced from `DEFAULT_SIGNAL_INGESTION_CONFIG.flooding.detection`)
 * so downstream callers continue to import a working default object.
 */
export const DEFAULT_FLOODING_DETECTION_CONFIG: FloodingDetectionConfig = Object.freeze({
  ...DEFAULT_SIGNAL_INGESTION_CONFIG.flooding.detection,
});

// ── Tier 2 significance gate (§8) ───────────────────────────────────────────

/**
 * Apply the RFC-0030 §8 Tier 2 significance threshold to a single cluster.
 *
 * The four conditions are evaluated independently so reasons can be reported
 * back; the cluster `qualified` IFF all four pass.
 *
 * `asOf` defaults to `new Date()` for cluster-age computation.
 */
export function assessTier2Significance(
  cluster: DemandCluster,
  threshold: Tier2SignificanceThreshold = DEFAULT_SIGNAL_INGESTION_CONFIG.tier2SignificanceThreshold,
  asOf: Date = new Date(),
): { state: Tier2SignificanceState; reasons: Tier2SignificanceReasons } {
  const reasons: Tier2SignificanceReasons = {
    signalCount: cluster.signalCount < threshold.minSignalCount,
    uniqueSources: cluster.uniqueSources < threshold.minUniqueSources,
    tier1SignalCount: cluster.tier1SignalCount < threshold.minTier1SignalCount,
    clusterAgeDays: clusterAgeDays(cluster, asOf) < threshold.minClusterAgeDays,
  };
  const qualified =
    !reasons.signalCount &&
    !reasons.uniqueSources &&
    !reasons.tier1SignalCount &&
    !reasons.clusterAgeDays;
  return { state: qualified ? 'qualified' : 'monitored', reasons };
}

/** Days elapsed between cluster.oldestSignalAt and `asOf`. */
function clusterAgeDays(cluster: DemandCluster, asOf: Date): number {
  const ageMs = asOf.getTime() - cluster.oldestSignalAt.getTime();
  return ageMs / (1000 * 60 * 60 * 24);
}

// ── SA resonance filter (§9) ────────────────────────────────────────────────

/**
 * Classify a cluster's SA resonance into one of five buckets per RFC-0030 §9.
 *
 * When `cluster.saResonance` is `undefined`, returns `pending` — the caller
 * is expected to populate the field via the Soul DID adapter before
 * invocation. Fail-closed: `pending` results in `eligibleForD1 = false`.
 */
export function classifySaResonance(
  cluster: DemandCluster,
  thresholds: SaResonanceThresholds = DEFAULT_SIGNAL_INGESTION_CONFIG.saResonanceThresholds,
): SaResonanceBucket {
  if (cluster.saResonance === undefined) return 'pending';
  const sa = cluster.saResonance;
  if (sa >= thresholds.fullWeight) return 'full';
  if (sa >= thresholds.discounted) return 'discounted';
  if (sa > thresholds.excluded) return 'low-sa-review';
  return 'out-of-scope';
}

// ── Combined Phase 4 cluster assessment ─────────────────────────────────────

/**
 * Options for `assessClusterSignificance()`.
 */
export interface AssessClusterSignificanceOptions {
  config?: SignalIngestionConfig;
  asOf?: Date;
}

/**
 * Result returned by `assessClusterSignificance()`.
 */
export interface AssessClusterSignificanceResult {
  assessments: SignificanceAssessedCluster[];
  /**
   * `signal-low-sa-for-review` Decisions emitted for clusters whose SA bucket
   * is `low-sa-review` — surfaces low-SA demand to the catalog for Product
   * Lead batch review (AC #3).
   */
  lowSaDecisions: SignalLowSaForReviewDecision[];
  /**
   * `signal-out-of-scope` Decisions emitted for clusters whose SA bucket is
   * `out-of-scope` — the demand is logged for separate triage rather than
   * fed into D1.
   */
  outOfScopeDecisions: SignalOutOfScopeDecision[];
}

/**
 * Apply Phase 4 significance + SA filter to a batch of `DemandCluster`s.
 *
 * The resulting `assessments` carry the final `d1WeightMultiplier` that
 * Phase 5 multiplies into the D1 formula. Below-threshold clusters retain
 * `eligibleForD1 = false` (not silently dropped) per RFC-0030 §8.
 *
 * `lowSaDecisions` are emitted for every cluster whose SA bucket is
 * `low-sa-review` — these are the AC #3 "low-SA-but-high-volume" Decisions.
 */
export function assessClusterSignificance(
  clusters: DemandCluster[],
  options: AssessClusterSignificanceOptions = {},
): AssessClusterSignificanceResult {
  const config = options.config ?? DEFAULT_SIGNAL_INGESTION_CONFIG;
  const asOf = options.asOf ?? new Date();

  const assessments: SignificanceAssessedCluster[] = [];
  const lowSaDecisions: SignalLowSaForReviewDecision[] = [];
  const outOfScopeDecisions: SignalOutOfScopeDecision[] = [];

  for (const cluster of clusters) {
    const { state: tier2Significance, reasons: tier2Reasons } = assessTier2Significance(
      cluster,
      config.tier2SignificanceThreshold,
      asOf,
    );
    const saResonanceBucket = classifySaResonance(cluster, config.saResonanceThresholds);

    const significanceMultiplier = tier2Significance === 'qualified' ? 1.0 : 0.0;
    const saMultiplier = SA_WEIGHT_MULTIPLIERS[saResonanceBucket];
    const d1WeightMultiplier = significanceMultiplier * saMultiplier;
    const eligibleForD1 =
      tier2Significance === 'qualified' &&
      saResonanceBucket !== 'out-of-scope' &&
      saResonanceBucket !== 'pending';

    assessments.push({
      cluster,
      tier2Significance,
      tier2Reasons,
      saResonanceBucket,
      eligibleForD1,
      d1WeightMultiplier,
    });

    // AC #3 — low-SA demand surfaces via Decision for Product Lead review.
    // Emitted even when the cluster is `monitored` (below significance) — the
    // operator should see that low-SA demand IS accumulating, regardless of
    // whether the Tier 2 threshold has been met.
    if (saResonanceBucket === 'low-sa-review' && cluster.saResonance !== undefined) {
      lowSaDecisions.push({
        type: 'Decision',
        decision: 'signal-low-sa-for-review',
        clusterId: cluster.clusterId,
        saResonance: cluster.saResonance,
        signalCount: cluster.signalCount,
        message:
          `Cluster ${cluster.clusterId} has SA resonance ${cluster.saResonance.toFixed(3)} ` +
          `(below 'discounted' threshold ${config.saResonanceThresholds.discounted.toFixed(2)}); ` +
          `flagging for Product Lead batch review.`,
      });
    }
    if (saResonanceBucket === 'out-of-scope' && cluster.saResonance !== undefined) {
      outOfScopeDecisions.push({
        type: 'Decision',
        decision: 'signal-out-of-scope',
        clusterId: cluster.clusterId,
        saResonance: cluster.saResonance,
        signalCount: cluster.signalCount,
        message:
          `Cluster ${cluster.clusterId} has SA resonance ${cluster.saResonance.toFixed(3)} ` +
          `(at or below 'excluded' threshold ${config.saResonanceThresholds.excluded.toFixed(2)}); ` +
          `logging as out-of-scope demand for separate triage.`,
      });
    }
  }

  return { assessments, lowSaDecisions, outOfScopeDecisions };
}

// ── Flooding detection (RFC-0030 §13.5 v0.3 — z-score, AISDLC-433) ──────────

/**
 * Options for `detectFlooding()`. The z-score detector REPLACES the
 * multiplier-based path that shipped with AISDLC-346.
 */
export interface DetectFloodingOptions {
  /**
   * Detection thresholds. Defaults to the loaded config's `flooding.detection`
   * block (or `DEFAULT_FLOODING_DETECTION_CONFIG` when no config supplied).
   */
  config?: FloodingDetectionConfig;

  /**
   * Quarantine sub-config. When omitted defaults to the framework default
   * (`enabled: true`, `durationHours: 24`). Used to populate the Decision's
   * `quarantineDurationHours` field + the `QuarantineStore` entries.
   */
  quarantineConfig?: FloodingQuarantineConfig;

  /**
   * Per-source rolling baseline. Each entry is a list of daily signal-count
   * observations for that source over the rolling `baselineDays` window.
   * The detector computes `{mean, stddev}` from the samples.
   *
   * Source key resolution (matches the pre-AISDLC-433 contract): prefers
   * `metadata.adapterName`, falls back to the `sourceId` prefix before the
   * first `-`.
   */
  perSourceBaselines?: PerSourceBaseline;

  /** Detection-window cutoff. Defaults to `new Date()`. */
  asOf?: Date;

  /**
   * Optional quarantine store the detector writes to. When supplied, every
   * flooded source has its signals tagged in the store. When omitted, the
   * Decision still carries the `quarantinedSourceIds` list but no
   * persistence happens — useful for pure unit testing.
   */
  quarantineStore?: QuarantineStore;

  /**
   * Decision ID factory. Defaults to a UTC timestamp + 8-char random suffix.
   * Tests override this to make assertions deterministic.
   */
  generateDecisionId?: () => string;
}

/**
 * Z-score detector — RFC-0030 §13.5 v0.3 trigger condition is
 * `windowCount > (mean + zScoreThreshold × stddev) AND uniqueSources_in_window
 * < minUniqueSourcesForSuspicion`.
 *
 * Returns a `FloodingDetectionResult` whose `status` discriminates the four
 * outcomes (flooded / clean / calibrating / empty-window). The caller routes
 * `result.decision` to the catalog when `status === 'flooded'`.
 *
 * Cold-start (AC #4): when the maximum per-source `baselineDays` observed
 * across all in-window sources is < `config.baselineDays`, the detector
 * returns `status: 'calibrating'` with no Decision — Tier 2 significance is
 * the sole defense until the rolling baseline has built up.
 *
 * Quarantine (AC #6, #7): when `quarantineConfig.enabled`, every in-window
 * signal from a flagged source is tagged in the supplied `quarantineStore`
 * with `expiresAt = asOf + quarantineDurationHours`. Auto-expiry happens
 * lazily on read (see `isSignalQuarantined()`).
 */
export function detectFlooding(
  signals: RawSignal[],
  options: DetectFloodingOptions = {},
): FloodingDetectionResult {
  const config = options.config ?? DEFAULT_FLOODING_DETECTION_CONFIG;
  const quarantineConfig =
    options.quarantineConfig ?? DEFAULT_SIGNAL_INGESTION_CONFIG.flooding.quarantine;
  const asOf = options.asOf ?? new Date();
  const perSourceBaselines = options.perSourceBaselines ?? {};
  const generateDecisionId = options.generateDecisionId ?? defaultDecisionIdFactory(asOf);

  const windowStartMs = asOf.getTime() - config.windowMinutes * 60 * 1000;
  const windowEndMs = asOf.getTime();

  const windowSignals = signals.filter((s) => {
    const ts = s.sourceTimestamp.getTime();
    return ts >= windowStartMs && ts <= windowEndMs;
  });

  if (windowSignals.length === 0) {
    return { status: 'empty-window', signalCount: 0, uniqueSources: 0, baselineDaysObserved: 0 };
  }

  // Group window signals by source.
  const perSourceWindowCounts = new Map<string, number>();
  const perSourceWindowSignals = new Map<string, RawSignal[]>();
  for (const s of windowSignals) {
    const src = resolveSourceName(s);
    perSourceWindowCounts.set(src, (perSourceWindowCounts.get(src) ?? 0) + 1);
    const bucket = perSourceWindowSignals.get(src) ?? [];
    bucket.push(s);
    perSourceWindowSignals.set(src, bucket);
  }

  const signalCount = windowSignals.length;
  const uniqueSources = perSourceWindowCounts.size;

  // Cold-start: take max baselineDays across all in-window sources. When ANY
  // source has the full window observed, the detector is calibrated for that
  // source; when NO source has the full window, we're calibrating overall.
  let maxBaselineDays = 0;
  for (const src of perSourceWindowCounts.keys()) {
    const samples = perSourceBaselines[src] ?? [];
    if (samples.length > maxBaselineDays) maxBaselineDays = samples.length;
  }

  if (maxBaselineDays < config.baselineDays) {
    return {
      status: 'calibrating',
      signalCount,
      uniqueSources,
      baselineDaysObserved: maxBaselineDays,
    };
  }

  // Trigger condition guard #2: uniqueSources_in_window < minUniqueSourcesForSuspicion.
  // When uniqueSources >= threshold, a "many sources contributing" pattern is
  // healthy organic traffic — z-score alone is not enough to call it flooding.
  // RFC-0030 §13.5: "trigger when volume > 3σ AND uniqueSources < 3".
  if (uniqueSources >= config.minUniqueSourcesForSuspicion) {
    return {
      status: 'clean',
      signalCount,
      uniqueSources,
      baselineDaysObserved: maxBaselineDays,
    };
  }

  // Per-source z-score check.
  const flaggedSources: FloodingSourceFlag[] = [];
  for (const [src, windowCount] of perSourceWindowCounts) {
    const samples = perSourceBaselines[src] ?? [];
    if (samples.length < config.baselineDays) continue; // skip cold per-source
    const stats = computeBaselineStat(samples);
    const zScore = computeZScore(windowCount, stats);
    if (zScore > config.zScoreThreshold) {
      flaggedSources.push({
        sourceId: src,
        zScore,
        windowCount,
        baselineMean: stats.mean,
        baselineStddev: stats.stddev,
        baselineDays: stats.sampleCount,
      });
    }
  }

  if (flaggedSources.length === 0) {
    return {
      status: 'clean',
      signalCount,
      uniqueSources,
      baselineDaysObserved: maxBaselineDays,
    };
  }

  // Build Decision + apply quarantine.
  const decisionId = generateDecisionId();
  const detectedAt = asOf.toISOString();

  const quarantinedSourceIds: string[] = [];
  const quarantineDurationHours = quarantineConfig.enabled ? quarantineConfig.durationHours : 0;
  if (quarantineConfig.enabled) {
    const expiresAt = new Date(asOf.getTime() + quarantineDurationHours * 60 * 60 * 1000);
    for (const flag of flaggedSources) {
      quarantinedSourceIds.push(flag.sourceId);
      const sourceSignals = perSourceWindowSignals.get(flag.sourceId) ?? [];
      if (options.quarantineStore !== undefined) {
        for (const sig of sourceSignals) {
          options.quarantineStore.quarantine({
            sourceId: sig.sourceId,
            adapterSource: flag.sourceId,
            decisionId,
            quarantinedAt: asOf,
            expiresAt,
            reason: `z-score ${flag.zScore.toFixed(2)}σ (baseline mean=${flag.baselineMean.toFixed(2)}, stddev=${flag.baselineStddev.toFixed(2)})`,
          });
        }
      }
    }
  }

  const decision: SignalFloodingDetectedDecision = {
    type: 'Decision',
    decision: 'signal-flooding-detected',
    decisionId,
    detectedAt,
    signalCount,
    uniqueSources,
    flaggedSources,
    quarantinedSourceIds,
    quarantineDurationHours,
    message: floodingMessage(flaggedSources, signalCount, uniqueSources, quarantineDurationHours),
  };

  return {
    status: 'flooded',
    decision,
    signalCount,
    uniqueSources,
    baselineDaysObserved: maxBaselineDays,
  };
}

/**
 * Population-standard-deviation baseline stat. Exposed for unit testing.
 * Returns `{mean: 0, stddev: 0, sampleCount: 0}` on empty input — caller's
 * cold-start gate should prevent that from reaching `computeZScore()`.
 */
export function computeBaselineStat(samples: readonly number[]): BaselineStat {
  if (samples.length === 0) return { mean: 0, stddev: 0, sampleCount: 0 };
  const sum = samples.reduce((acc, n) => acc + n, 0);
  const mean = sum / samples.length;
  const sqSum = samples.reduce((acc, n) => acc + (n - mean) ** 2, 0);
  const stddev = Math.sqrt(sqSum / samples.length);
  return { mean, stddev, sampleCount: samples.length };
}

/**
 * Z-score of a single observation against `BaselineStat`. When `stddev === 0`
 * (degenerate baseline — every sample identical), returns `+Infinity` if the
 * observation exceeds the mean, `0` if it equals the mean — matches the
 * statistical convention that any deviation from a zero-variance baseline is
 * infinitely surprising. Exposed for unit testing.
 */
export function computeZScore(observation: number, stats: BaselineStat): number {
  if (stats.stddev === 0) {
    if (observation > stats.mean) return Number.POSITIVE_INFINITY;
    return 0;
  }
  return (observation - stats.mean) / stats.stddev;
}

function floodingMessage(
  flaggedSources: FloodingSourceFlag[],
  signalCount: number,
  uniqueSources: number,
  quarantineDurationHours: number,
): string {
  const flaggedNames = flaggedSources.map((f) => `${f.sourceId} (z=${f.zScore.toFixed(2)}σ)`);
  const quarantinePart =
    quarantineDurationHours > 0
      ? ` Quarantine applied for ${quarantineDurationHours}h.`
      : ' Quarantine disabled — signals stay live.';
  return (
    `Flooding detected: ${signalCount} signals over ${uniqueSources} sources in the detection window; ` +
    `flagged sources [${flaggedNames.join(', ')}].${quarantinePart}`
  );
}

/**
 * Resolve a source identifier for a signal — prefers `metadata.adapterName`,
 * falls back to a `sourceId` prefix (the segment before the first `-`).
 */
function resolveSourceName(signal: RawSignal): string {
  const fromMeta = signal.metadata?.['adapterName'];
  if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta;
  const dashIdx = signal.sourceId.indexOf('-');
  if (dashIdx > 0) return signal.sourceId.slice(0, dashIdx);
  return signal.sourceId;
}

function defaultDecisionIdFactory(asOf: Date): () => string {
  let counter = 0;
  return (): string => {
    counter += 1;
    const suffix = counter > 1 ? `-${counter}` : '';
    return `flooding-${asOf.toISOString().replace(/[:.]/g, '')}${suffix}`;
  };
}

// ── Quarantine store + operator unquarantine (AC #6, #7, #8, #9) ────────────

/**
 * A single entry in the quarantine store. Created by `detectFlooding()` when
 * a flooded source's signals are quarantined; consumed by:
 *   - The D1 path, to exclude quarantined signals from cluster scoring
 *     (`isSignalQuarantined()`).
 *   - The operator unquarantine flow (`unquarantineFlooded()`) for one-click
 *     release after a false-positive review.
 *   - The RFC-0023 Blockers pane, which renders pending Decisions + offers
 *     the unquarantine action.
 */
export interface QuarantineEntry {
  /** Signal `sourceId` quarantined. */
  sourceId: string;
  /** Adapter-level source key (the key used by the detector + baselines). */
  adapterSource: string;
  /** Originating Decision ID. The false-positive Decision references this. */
  decisionId: string;
  quarantinedAt: Date;
  /** When quarantine auto-expires. */
  expiresAt: Date;
  /** Free-form rationale (z-score + baseline stats). */
  reason: string;
}

/**
 * Minimal in-memory `QuarantineStore` implementation. Production deployments
 * persist to events.jsonl + a sidecar quarantine state file; the in-memory
 * shape is the contract the persistent implementation honours.
 *
 * The store is intentionally narrow: `quarantine`, `isQuarantined`,
 * `getActiveEntries`, `getEntryByDecisionId`, `release`. No batch
 * operations — operators unquarantine one Decision at a time per the
 * RFC-0023 one-click model.
 */
export interface QuarantineStore {
  /** Record a new quarantine entry. */
  quarantine(entry: QuarantineEntry): void;
  /** Whether a signal sourceId is currently quarantined (NOT auto-expired). */
  isQuarantined(sourceId: string, asOf?: Date): boolean;
  /**
   * All currently-active quarantine entries (auto-expired entries excluded).
   * Used by the TUI Blockers pane to render pending decisions.
   */
  getActiveEntries(asOf?: Date): QuarantineEntry[];
  /** Entries created by a specific Decision (for unquarantine routing). */
  getEntryByDecisionId(decisionId: string): QuarantineEntry[];
  /** Release all entries for the given Decision (idempotent). */
  release(decisionId: string, releasedAt?: Date): QuarantineEntry[];
}

/**
 * Default in-memory store. Tests use this directly; production callers should
 * implement a persistent variant satisfying the same interface.
 */
export class InMemoryQuarantineStore implements QuarantineStore {
  private readonly entries: QuarantineEntry[] = [];
  private readonly released = new Set<string>();

  quarantine(entry: QuarantineEntry): void {
    this.entries.push(entry);
  }

  isQuarantined(sourceId: string, asOf: Date = new Date()): boolean {
    const ms = asOf.getTime();
    for (const e of this.entries) {
      if (e.sourceId !== sourceId) continue;
      if (this.released.has(e.decisionId)) continue;
      if (e.expiresAt.getTime() <= ms) continue;
      return true;
    }
    return false;
  }

  getActiveEntries(asOf: Date = new Date()): QuarantineEntry[] {
    const ms = asOf.getTime();
    return this.entries.filter(
      (e) => !this.released.has(e.decisionId) && e.expiresAt.getTime() > ms,
    );
  }

  getEntryByDecisionId(decisionId: string): QuarantineEntry[] {
    return this.entries.filter((e) => e.decisionId === decisionId);
  }

  release(decisionId: string, _releasedAt: Date = new Date()): QuarantineEntry[] {
    const matched = this.getEntryByDecisionId(decisionId);
    if (matched.length === 0) return [];
    this.released.add(decisionId);
    return matched;
  }
}

/**
 * Convenience: check whether a single `RawSignal` is currently quarantined by
 * looking up its `sourceId` in the store. The D1 path calls this when
 * computing `eligibleForD1` — quarantined signals are excluded from the
 * D1(cluster) formula per AC #6.
 *
 * Returns `false` when no store is supplied (back-compat — pre-AISDLC-433
 * D1 paths didn't have a quarantine layer to consult).
 */
export function isSignalQuarantined(
  signal: RawSignal,
  store: QuarantineStore | undefined,
  asOf: Date = new Date(),
): boolean {
  if (store === undefined) return false;
  return store.isQuarantined(signal.sourceId, asOf);
}

/**
 * Operator unquarantine Decision — emitted by `unquarantineFlooded()` per
 * AC #9. References the original flooding Decision so the v2
 * reputation-weighting layer can calibrate against false-positive feedback.
 */
export interface SignalFloodingFalsePositiveDecision {
  type: 'Decision';
  decision: 'signal-flooding-false-positive';
  /** Stable ID for this false-positive Decision (audit trail). */
  decisionId: string;
  /** Original `signal-flooding-detected` Decision ID. */
  originalDecisionId: string;
  releasedAt: string;
  /** Source IDs released back to D1 candidacy. */
  releasedSourceIds: string[];
  /** Free-form operator note explaining the false-positive call. */
  operatorNote?: string;
  message: string;
}

/**
 * Options for `unquarantineFlooded()`.
 */
export interface UnquarantineFloodedOptions {
  store: QuarantineStore;
  /** Decision ID of the original `signal-flooding-detected` Decision. */
  originalDecisionId: string;
  /** Optional operator note (free-form rationale). */
  operatorNote?: string;
  /** Clock override for the `releasedAt` timestamp. */
  asOf?: Date;
  /** Decision-ID factory for the false-positive Decision (tests override). */
  generateDecisionId?: () => string;
}

/**
 * Operator one-click unquarantine — releases every signal entry tagged with
 * `originalDecisionId` and emits the `signal-flooding-false-positive`
 * Decision per RFC-0030 §13.5 + AC #8 + AC #9.
 *
 * Returns `null` when no active entries match the Decision ID (idempotent —
 * the operator's second click on the same row is a no-op + null result).
 */
export function unquarantineFlooded(
  options: UnquarantineFloodedOptions,
): SignalFloodingFalsePositiveDecision | null {
  const asOf = options.asOf ?? new Date();
  const generateDecisionId =
    options.generateDecisionId ?? falsePositiveDecisionIdFactory(asOf, options.originalDecisionId);

  const released = options.store.release(options.originalDecisionId, asOf);
  if (released.length === 0) return null;

  const releasedSourceIds = Array.from(new Set(released.map((e) => e.sourceId)));
  const decisionId = generateDecisionId();
  return {
    type: 'Decision',
    decision: 'signal-flooding-false-positive',
    decisionId,
    originalDecisionId: options.originalDecisionId,
    releasedAt: asOf.toISOString(),
    releasedSourceIds,
    operatorNote: options.operatorNote,
    message:
      `Operator marked flooding Decision ${options.originalDecisionId} as false-positive; ` +
      `released ${releasedSourceIds.length} source(s) back to D1 candidacy. ` +
      `v2 reputation-weighting layer will use this Decision as calibration signal.`,
  };
}

function falsePositiveDecisionIdFactory(asOf: Date, originalDecisionId: string): () => string {
  return (): string =>
    `flooding-fp-${asOf.toISOString().replace(/[:.]/g, '')}-${originalDecisionId.slice(-8)}`;
}

// ── OQ-13.3 residency-violation gate (adapter-level) ────────────────────────

/**
 * Per-adopter regime declaration consumed by `checkSignalResidency`. Composes
 * with RFC-0022 Compliance Posture per RFC-0030 OQ-13.3 — the adopter declares
 * which regimes are active and the allowed regions per regime; signal-ingestion
 * refuses signals from outside those regions.
 *
 * `regimes` is the active regime set (e.g. `['gdpr']`, `['hipaa', 'gdpr']`).
 * `allowedRegionsByRegime` maps each regime to the set of region tags that
 * regime permits (e.g. `gdpr: ['eu', 'gb']`, `hipaa: ['us']`). A signal is
 * permitted IFF its `region` is in EVERY active regime's allowed-regions list.
 *
 * `allowedRegionsByRegime` keys not present in `regimes` are ignored (the
 * regime isn't active for this adopter).
 *
 * `allowedRegionsByRegime` of `{}` (empty) for an active regime means NO
 * regions are explicitly permitted → all signals are refused for that regime.
 * Operators should declare regions OR remove the regime from the active set.
 */
export interface ResidencyRegimeDeclaration {
  regimes: string[];
  allowedRegionsByRegime: Record<string, string[]>;
}

/**
 * Outcome of residency-check on a single signal.
 *   - `{ permitted: true }` — signal MAY pass; adapter may emit it.
 *   - `{ permitted: false, decision }` — signal MUST be refused; adapter logs
 *     the Decision + emits the regimeOverrides clarification task.
 */
export type SignalResidencyCheck =
  | { permitted: true }
  | { permitted: false; decision: SignalResidencyViolationDecision };

/**
 * Check a single signal against the adopter's declared residency regimes.
 *
 * **Behaviour**:
 *   - When `declaration.regimes` is empty → signal is permitted (no regime
 *     constraints declared). Adopters not declaring a regime are not subject
 *     to residency gating.
 *   - When `signal.region` is `undefined` AND at least one regime is active →
 *     signal is permitted (the adapter didn't surface region metadata, which
 *     is treated as "not subject to gating" rather than "fails the gate" to
 *     avoid false-positives on adapters that don't yet plumb region — a
 *     visible-gap metric for the operator's regime config rollout).
 *   - When `signal.region` is present AND at least one active regime's
 *     `allowedRegions` does NOT include it → signal is REFUSED and the
 *     `Decision` records every regime that rejected the signal.
 *
 * The adapter SHOULD NOT call `fetchSignals` for refused signals — the
 * return-value pattern lets the adapter short-circuit per-signal.
 */
export function checkSignalResidency(
  signal: RawSignal,
  declaration: ResidencyRegimeDeclaration,
  adapterName: SignalSourceName,
): SignalResidencyCheck {
  if (declaration.regimes.length === 0) return { permitted: true };
  if (signal.region === undefined) return { permitted: true };

  const region = signal.region.toLowerCase();
  const violatedRegimes: string[] = [];
  const allowedAcrossAllRegimes = new Set<string>();

  for (const regime of declaration.regimes) {
    const allowed = declaration.allowedRegionsByRegime[regime] ?? [];
    if (allowed.length === 0) {
      // Active regime with no allowed regions = all signals violate.
      violatedRegimes.push(regime);
      continue;
    }
    const allowedLower = allowed.map((r) => r.toLowerCase());
    for (const r of allowedLower) allowedAcrossAllRegimes.add(r);
    if (!allowedLower.includes(region)) {
      violatedRegimes.push(regime);
    }
  }

  if (violatedRegimes.length === 0) return { permitted: true };

  return {
    permitted: false,
    decision: {
      type: 'Decision',
      decision: 'signal-residency-violation',
      adapter: adapterName,
      sourceId: signal.sourceId,
      signalRegion: signal.region,
      violatedRegimes,
      allowedRegions: Array.from(allowedAcrossAllRegimes).sort(),
      message:
        `Signal ${signal.sourceId} from adapter '${adapterName}' has region '${signal.region}' ` +
        `which violates the residency constraint(s) of active regime(s) [${violatedRegimes.join(', ')}]; ` +
        `signal refused. Emit clarification task to update compliance.yaml regimeOverrides if ` +
        `the regime declaration is incorrect, or drop the source if non-compliant.`,
    },
  };
}

/**
 * Convenience wrapper: filter a batch of signals against the residency gate,
 * returning the (possibly empty) list of permitted signals + the list of
 * Decision records for refused signals. Adapter implementations can call this
 * in their `fetchSignals()` body to enforce residency before returning.
 */
export function filterSignalsByResidency(
  signals: RawSignal[],
  declaration: ResidencyRegimeDeclaration,
  adapterName: SignalSourceName,
): { permitted: RawSignal[]; decisions: SignalResidencyViolationDecision[] } {
  const permitted: RawSignal[] = [];
  const decisions: SignalResidencyViolationDecision[] = [];
  for (const s of signals) {
    const result = checkSignalResidency(s, declaration, adapterName);
    if (result.permitted) {
      permitted.push(s);
    } else {
      decisions.push(result.decision);
    }
  }
  return { permitted, decisions };
}
