/**
 * RFC-0030 Phase 4 — Tier 2 significance threshold, SA resonance filter,
 * flooding detection, residency-violation gate.
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
 *   3. **OQ-13.5 flooding detection**: across a population of recent signals,
 *      Stage A classifies severity by three independent signals:
 *        - **Volume spike**: signals-per-source exceeds `volumeSpikeMultiplier`
 *          × baseline mean.
 *        - **Low source diversity**: `uniqueSources / signalCount` falls below
 *          `minSourceDiversityRatio`.
 *        - **Per-source baseline drift**: any source's signal count exceeds
 *          `sourceBaselineDriftMultiplier` × its rolling baseline.
 *      Severity:
 *        - `low`  — one signal tripped; auto-throttle low-confidence sources
 *          (action surfaced as `auto-throttle`).
 *        - `medium` — two signals tripped; auto-throttle + log for operator
 *          batch review.
 *        - `high` — all three tripped; surface to operator batch review
 *          (action `operator-review`).
 *      Pipeline NEVER halts on flooding (AC #7 — G0 non-blocking contract).
 *
 *   4. **OQ-13.3 residency-violation gate** (adapter-level): per `checkSignalResidency`,
 *      a signal whose `region` falls outside the adopter's declared regime
 *      `allowedRegions` is refused at adapter level. Pipeline never halts.
 *
 * @module signal-ingestion/significance
 */

import type { DemandCluster } from './clustering.js';
import type {
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
 * Flooding severity per OQ-13.5 Stage A. Three thresholds combine
 * monotonically — `low` (1 tripped), `medium` (2 tripped), `high` (3 tripped).
 */
export type FloodingSeverity = 'low' | 'medium' | 'high';

/**
 * Recommended response per flooding severity. Pipeline never halts; the
 * response is consumed by RFC-0035 catalog batching.
 */
export type FloodingResponse = 'auto-throttle' | 'auto-throttle-and-review' | 'operator-review';

/**
 * Per-source flooding measurement. `signalCount > baselineCount` × multiplier
 * triggers the per-source baseline-drift signal.
 */
export interface SourceFloodingStat {
  sourceId: string;
  signalCount: number;
  baselineCount: number;
}

/**
 * Stage A classification of a candidate flooding event per OQ-13.5.
 */
export interface SignalFloodingDetectedDecision {
  type: 'Decision';
  decision: 'signal-flooding-detected';
  severity: FloodingSeverity;
  /** Which Stage A indicators tripped. */
  indicators: {
    volumeSpike: boolean;
    lowSourceDiversity: boolean;
    perSourceBaselineDrift: boolean;
  };
  /** Total signal count over the detection window. */
  signalCount: number;
  /** Number of unique sources contributing to the window. */
  uniqueSources: number;
  /** Population mean of signals per source over the baseline window. */
  baselineSignalsPerSource: number;
  /** Highest per-source drift ratio (max(signalCount / baselineCount)). */
  maxSourceBaselineDriftRatio: number;
  /** Source IDs flagged for per-source baseline drift. */
  driftingSources: string[];
  /** Recommended response per AC #5. */
  response: FloodingResponse;
  message: string;
}

// ── Configurable parameters ─────────────────────────────────────────────────

/**
 * Flooding-detection thresholds. Operators may override via
 * `floodingDetection:` in `.ai-sdlc/signal-ingestion.yaml` (Phase 6 surfaces
 * this as a config field; Phase 4 ships sensible defaults).
 *
 * Defaults chosen to be conservative — `low` severity should fire on
 * meaningfully elevated traffic, not a 10%-over-baseline blip.
 */
export interface FloodingDetectionConfig {
  /**
   * Detection window in hours. Signals with `sourceTimestamp` within
   * `[asOf - windowHours, asOf]` form the detection window.
   * Defaults to 24 hours.
   */
  windowHours: number;

  /**
   * Volume spike multiplier. Stage A trips `volumeSpike` when the detection
   * window's signal-per-source mean exceeds the baseline mean by this factor.
   * Defaults to 3.0 (3× baseline).
   */
  volumeSpikeMultiplier: number;

  /**
   * Minimum source diversity ratio. Stage A trips `lowSourceDiversity` when
   * `uniqueSources / signalCount` falls below this value (i.e. a small number
   * of sources is producing a large number of signals — the classic flooding
   * signature). Defaults to 0.2 (≥ 80% of the window must come from < 20% of
   * sources to trip).
   *
   * NOTE: also requires `signalCount >= minSignalCountForDiversityCheck` to
   * avoid tripping on tiny populations (e.g. 1 signal / 1 source has a
   * diversity ratio of 1.0 which would never trip, but 5 signals / 1 source
   * = 0.2 would trip prematurely).
   */
  minSourceDiversityRatio: number;

  /**
   * Minimum signal count below which `lowSourceDiversity` is suppressed
   * (avoids tripping on tiny populations). Defaults to 10.
   */
  minSignalCountForDiversityCheck: number;

  /**
   * Per-source baseline drift multiplier. Stage A trips
   * `perSourceBaselineDrift` when any single source's signal count exceeds
   * its baseline count by this factor. Defaults to 5.0.
   */
  sourceBaselineDriftMultiplier: number;

  /**
   * Confidence floor for auto-throttling. Sources with `confidence` (per the
   * Source Reputation registry, when wired in v2) below this are eligible for
   * the `auto-throttle` action when flooding fires at `low` or `medium`
   * severity. Defaults to 0.5.
   *
   * v1 NOTE: per AC #5, the actual throttle action is delegated to the
   * catalog (we emit the Decision; the catalog applies the action). v1
   * source-reputation = none; this field is preserved for v2 wiring.
   */
  lowConfidenceThreshold: number;
}

/** Defaults for `FloodingDetectionConfig`. */
export const DEFAULT_FLOODING_DETECTION_CONFIG: FloodingDetectionConfig = Object.freeze({
  windowHours: 24,
  volumeSpikeMultiplier: 3.0,
  minSourceDiversityRatio: 0.2,
  minSignalCountForDiversityCheck: 10,
  sourceBaselineDriftMultiplier: 5.0,
  lowConfidenceThreshold: 0.5,
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

// ── Flooding detection (OQ-13.5 Stage A) ────────────────────────────────────

/**
 * Options for `detectFlooding()`.
 */
export interface DetectFloodingOptions {
  /**
   * Detection-window thresholds. Defaults to `DEFAULT_FLOODING_DETECTION_CONFIG`.
   */
  config?: FloodingDetectionConfig;

  /**
   * Per-source baseline counts (rolling baseline from prior pipeline runs).
   * Keys are source adapter names (`signal-source-support-ticket`,
   * `signal-source-community-thread`, etc.); values are the baseline signal
   * count for that source over a comparable window.
   *
   * Sources NOT in this map default to a baseline of 0 (any signal trips the
   * per-source drift indicator) — typical when a brand-new adapter starts
   * producing signals. Operators wire this map from their historical-data
   * substrate; v1 uses an empty map by default which means the per-source
   * drift indicator only trips for sources with explicit baselines.
   */
  perSourceBaselines?: Record<string, number>;

  /**
   * Population baseline (mean signals-per-source) from prior pipeline runs.
   * Defaults to 0 (any window triggers `volumeSpike` when at least one source
   * has signals). Operators wire this from the historical-data substrate.
   */
  populationBaselineSignalsPerSource?: number;

  /** Window cutoff. Defaults to `new Date()`. */
  asOf?: Date;
}

/**
 * Detect adversarial flooding in a recent-signals window per OQ-13.5 Stage A.
 *
 * Returns `null` when NO indicators tripped (no flooding detected). When at
 * least one indicator tripped, returns a `SignalFloodingDetectedDecision`
 * with severity = number of indicators tripped (`low` | `medium` | `high`).
 *
 * **Algorithm**:
 *   1. Filter `signals` to the detection window (`[asOf - windowHours, asOf]`).
 *   2. Group by source adapter name (`signal.metadata?.adapterName`); fall back
 *      to the source-id prefix when adapterName isn't present.
 *   3. Compute:
 *        - `volumeSpike` = `windowSignalsPerSourceMean > volumeSpikeMultiplier
 *          × populationBaselineSignalsPerSource` (skipped when baseline is 0
 *          AND window has fewer signals than `volumeSpikeMultiplier × 1`).
 *        - `lowSourceDiversity` = `signalCount >=
 *          minSignalCountForDiversityCheck` AND `uniqueSources / signalCount <
 *          minSourceDiversityRatio`.
 *        - `perSourceBaselineDrift` = any source's window count exceeds
 *          `sourceBaselineDriftMultiplier × perSourceBaselines[source]`.
 *   4. Severity = sum of true indicators → `low` (1), `medium` (2), `high` (3).
 *   5. Response per AC #5:
 *        - `low`    → `auto-throttle`
 *        - `medium` → `auto-throttle-and-review`
 *        - `high`   → `operator-review`
 *
 * Returns `null` when no indicators trip OR when the window is empty.
 */
export function detectFlooding(
  signals: RawSignal[],
  options: DetectFloodingOptions = {},
): SignalFloodingDetectedDecision | null {
  const config = options.config ?? DEFAULT_FLOODING_DETECTION_CONFIG;
  const asOf = options.asOf ?? new Date();
  const perSourceBaselines = options.perSourceBaselines ?? {};
  const populationBaseline = options.populationBaselineSignalsPerSource ?? 0;

  const windowStartMs = asOf.getTime() - config.windowHours * 60 * 60 * 1000;
  const windowEndMs = asOf.getTime();
  const windowSignals = signals.filter((s) => {
    const ts = s.sourceTimestamp.getTime();
    return ts >= windowStartMs && ts <= windowEndMs;
  });

  if (windowSignals.length === 0) return null;

  // Group by source adapter name.
  const perSourceCounts = new Map<string, number>();
  for (const s of windowSignals) {
    const src = resolveSourceName(s);
    perSourceCounts.set(src, (perSourceCounts.get(src) ?? 0) + 1);
  }

  const signalCount = windowSignals.length;
  const uniqueSources = perSourceCounts.size;
  const signalsPerSourceMean = signalCount / uniqueSources;

  // Indicator 1: volume spike
  // When baseline = 0, fall back to a small-population guard: only trip when
  // window mean exceeds the multiplier itself (e.g. 3.0 default → need ≥ 4
  // signals per source). This avoids tripping on a single-signal window when
  // no baseline has been wired yet.
  let volumeSpike: boolean;
  if (populationBaseline > 0) {
    volumeSpike = signalsPerSourceMean > config.volumeSpikeMultiplier * populationBaseline;
  } else {
    volumeSpike = signalsPerSourceMean > config.volumeSpikeMultiplier;
  }

  // Indicator 2: low source diversity (guarded by minSignalCountForDiversityCheck)
  let lowSourceDiversity = false;
  if (signalCount >= config.minSignalCountForDiversityCheck) {
    const diversityRatio = uniqueSources / signalCount;
    lowSourceDiversity = diversityRatio < config.minSourceDiversityRatio;
  }

  // Indicator 3: per-source baseline drift
  let perSourceBaselineDrift = false;
  const driftingSources: string[] = [];
  let maxDriftRatio = 0;
  for (const [src, count] of perSourceCounts) {
    const baseline = perSourceBaselines[src] ?? 0;
    if (baseline === 0) continue; // skip sources without explicit baseline
    const ratio = count / baseline;
    if (ratio > maxDriftRatio) maxDriftRatio = ratio;
    if (count > config.sourceBaselineDriftMultiplier * baseline) {
      perSourceBaselineDrift = true;
      driftingSources.push(src);
    }
  }

  const indicators = { volumeSpike, lowSourceDiversity, perSourceBaselineDrift };
  const trippedCount =
    (volumeSpike ? 1 : 0) + (lowSourceDiversity ? 1 : 0) + (perSourceBaselineDrift ? 1 : 0);

  if (trippedCount === 0) return null;

  let severity: FloodingSeverity;
  let response: FloodingResponse;
  if (trippedCount === 1) {
    severity = 'low';
    response = 'auto-throttle';
  } else if (trippedCount === 2) {
    severity = 'medium';
    response = 'auto-throttle-and-review';
  } else {
    severity = 'high';
    response = 'operator-review';
  }

  return {
    type: 'Decision',
    decision: 'signal-flooding-detected',
    severity,
    indicators,
    signalCount,
    uniqueSources,
    baselineSignalsPerSource: populationBaseline,
    maxSourceBaselineDriftRatio: maxDriftRatio,
    driftingSources,
    response,
    message: floodingMessage(severity, indicators, signalCount, uniqueSources),
  };
}

function floodingMessage(
  severity: FloodingSeverity,
  indicators: SignalFloodingDetectedDecision['indicators'],
  signalCount: number,
  uniqueSources: number,
): string {
  const trippedNames: string[] = [];
  if (indicators.volumeSpike) trippedNames.push('volume-spike');
  if (indicators.lowSourceDiversity) trippedNames.push('low-source-diversity');
  if (indicators.perSourceBaselineDrift) trippedNames.push('per-source-baseline-drift');
  return (
    `Flooding detected at severity '${severity}' (${trippedNames.join(' + ')}); ` +
    `${signalCount} signals over ${uniqueSources} sources in the detection window.`
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
