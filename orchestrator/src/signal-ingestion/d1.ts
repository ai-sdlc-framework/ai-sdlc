/**
 * RFC-0030 Phase 5 — D1 formula reformulation + RFC-0008 PPA integration.
 *
 * Reformulates the existing PPA D1 (Demand Pressure) input to consume
 * cluster-level demand from the signal-ingestion pipeline per RFC-0030 §10:
 *
 * ```
 * D1(cluster) = Σ over signals in cluster:
 *     signal.baseWeight              # 1.0 Tier 1; 0.3 Tier 2 above threshold; 0 below
 *     × signal.tierMultiplier        # configurable per deployment (§6.1)
 *     × signal.icpResonance          # configurable per deployment (§6.2)
 *     × signal.recencyDecay          # exp(-age_days × ln(2) / half_life_days)
 *     × cluster.saResonance          # filter per §9 (applied via the SA bucket multiplier)
 *
 * D1 is then normalized across all active clusters to [0, 1] and fed into the
 * existing PPA D formula (PPA v1.1 §3.1).
 * ```
 *
 * **Non-replacement contract (AC #2 + AC #4)**: human-authored backlog items
 * continue to feed D1 alongside signal-pipeline-derived demand. The pipeline
 * adds a parallel input path; the existing path is preserved. When the
 * pipeline is disabled (`config.enabled === false`, the default), this module
 * contributes zero signal-pipeline demand — the composed D1 reduces to the
 * backlog-item input unchanged. When both inputs are active, weights from
 * `config.d1Composition` blend them (default 50/50).
 *
 * **RFC-0008 PPA Triad integration (AC #3)**: the resulting per-item composed
 * D1 score is consumed by the `enrichDemandSignalFromClusters()` helper which
 * overlays it onto a `PriorityInput.demandSignal` field — the same field the
 * admission composite (`admission-composite.ts`) reads via `mapIssueToPriorityInput`
 * for the Sα₁ × Dπ_adjusted × Eρ₅ admission gate per RFC-0008 §A.6.
 *
 * **Cluster-to-item routing**: the pipeline produces cluster-level demand;
 * admission scoring is per-item (per backlog task / GitHub issue). The
 * composition treats the pipeline-derived signal as a *deployment-level
 * demand floor* that lifts the demand signal for items whose subject
 * matches an active cluster theme (cluster-to-item matching is left to a
 * caller-supplied lookup in v1; v2 will wire to RFC-0024 capture matching).
 *
 * @module signal-ingestion/d1
 */

import type { ClusteredSignalInput } from './clustering-types.js';
import { DEFAULT_SIGNAL_INGESTION_CONFIG } from './config.js';
import type { D1CompositionWeights, SignalIngestionConfig } from './config.js';
import type { SignificanceAssessedCluster } from './significance.js';

// ── Public types ────────────────────────────────────────────────────────────

/**
 * Per-cluster D1 score breakdown — produced by `computeClusterD1()`.
 *
 * `rawScore` is the §10 formula output BEFORE normalisation (sum across
 * cluster members × the SA bucket multiplier). `normalizedScore` is filled
 * in by `aggregateD1FromClusters()` after the full population is known.
 */
export interface ClusterD1Score {
  clusterId: string;
  /** Sum of per-signal weights × cluster SA multiplier; pre-normalisation. */
  rawScore: number;
  /**
   * Filled by `aggregateD1FromClusters()` — `rawScore / max(rawScore across
   * eligible clusters)`. Range [0, 1]. `0` when the cluster is ineligible
   * (significance gate failed or SA bucket excludes it).
   */
  normalizedScore: number;
  /** Whether the cluster contributes to D1 at all. Mirrors `eligibleForD1`. */
  eligible: boolean;
  /** Cluster size (member count) — useful for downstream auditing. */
  signalCount: number;
}

/**
 * Result of aggregating per-cluster D1 scores into a deployment-level
 * pipeline-derived demand input.
 */
export interface AggregatedD1Result {
  /** Per-cluster scores, with normalised values populated. */
  clusters: ClusterD1Score[];
  /**
   * Maximum raw score across eligible clusters (the normalisation denominator).
   * `0` when no clusters are eligible.
   */
  maxRawScore: number;
  /**
   * Population-level summary — the mean normalised score across eligible
   * clusters. Range [0, 1]. Useful as a deployment-level "ambient pipeline
   * demand" indicator when no per-item cluster match exists.
   */
  meanNormalizedScore: number;
}

/**
 * Inputs to `composeD1Inputs()` per RFC-0030 §10 non-replacement contract.
 */
export interface ComposeD1InputsArgs {
  /**
   * Pipeline-derived per-item demand score (post-`enrichDemandSignalFromClusters`
   * matching). Range expected [0, 1]. `undefined` when no cluster match exists
   * — composition then falls back to `backlogItemD1` alone.
   */
  signalPipelineD1?: number;
  /**
   * Human-authored backlog-item demand score from the existing PPA path
   * (`mapIssueToPriorityInput().demandSignal`). Range [0, 1]. `undefined`
   * when the backlog has no demand for the item (rare; treated as 0).
   */
  backlogItemD1?: number;
  /**
   * Signal-ingestion config — `d1Composition` weights + `enabled` flag drive
   * the blend. Defaults to `DEFAULT_SIGNAL_INGESTION_CONFIG` (pipeline disabled).
   */
  config?: SignalIngestionConfig;
}

/** Result of composing the two D1 input streams. */
export interface ComposedD1Result {
  /** The final blended D1 input. Range [0, 1]. */
  composedScore: number;
  /** Normalised weight actually applied to the pipeline input. */
  signalPipelineWeightApplied: number;
  /** Normalised weight actually applied to the backlog input. */
  backlogItemWeightApplied: number;
  /**
   * Audit trail — what each branch contributed before weighting:
   *   - `signalPipelineContribution` = `signalPipelineD1 × signalPipelineWeightApplied`
   *   - `backlogItemContribution` = `backlogItemD1 × backlogItemWeightApplied`
   */
  signalPipelineContribution: number;
  backlogItemContribution: number;
  /**
   * Backward-compat indicator — `true` when the pipeline was disabled OR no
   * pipeline-derived signal was provided, so the result is the backlog input
   * unchanged. AC #4 audit hook.
   */
  pipelineBypass: boolean;
}

// ── §10 formula — per cluster ───────────────────────────────────────────────

/**
 * Compute the per-signal weight from a cluster member's `ClusteredSignalInput`
 * + config-derived multipliers. Mirrors `classifier.computeSignalWeight()` but
 * operates on the Phase-3 cluster-member shape (which dropped the
 * `tierMultiplier` / `icpResonanceWeight` convenience fields the classifier
 * carried for Phase-4 use).
 *
 * Order: `baseWeight × tierMultiplier × icpResonanceWeight × recencyDecay`
 * exactly per §10 lines 1-4 of the formula. The cluster-level
 * `saResonance` factor (§10 line 5) is applied OUTSIDE this function, in
 * `computeClusterD1()`, since it's a cluster-wide property.
 */
function computeClusterMemberWeight(
  member: ClusteredSignalInput,
  config: SignalIngestionConfig,
): number {
  // Tier 1 sources base weight = 1.0; Tier 2 = 0.3 (matches classifier convention
  // — Phase 4 significance gate independently zeros out below-threshold clusters
  // via SA_WEIGHT_MULTIPLIERS, so we don't double-discount here).
  const adapterTier = member.adapterTier ?? 1;
  const baseWeight = adapterTier === 1 ? 1.0 : 0.3;
  const tierMultiplier = config.tierMultipliers[member.customerTier];
  const icpWeight = config.icpResonanceWeights[member.icpResonance];
  return baseWeight * tierMultiplier * icpWeight * member.recencyDecay;
}

/**
 * Apply RFC-0030 §10 D1 formula to a single significance-assessed cluster.
 *
 * `rawScore` is the sum of per-member weights × the cluster's SA bucket
 * multiplier (§10 line 5 — the SA filter applied at cluster level).
 *
 * When the cluster is ineligible (`assessment.eligibleForD1 === false` —
 * Tier 2 threshold failed OR SA bucket is `out-of-scope` / `pending`), the
 * raw score is forced to 0 per §8 / §9 contract.
 */
export function computeClusterD1(
  assessment: SignificanceAssessedCluster,
  config: SignalIngestionConfig = DEFAULT_SIGNAL_INGESTION_CONFIG,
): ClusterD1Score {
  if (!assessment.eligibleForD1) {
    return {
      clusterId: assessment.cluster.clusterId,
      rawScore: 0,
      normalizedScore: 0,
      eligible: false,
      signalCount: assessment.cluster.signalCount,
    };
  }

  const memberSum = assessment.cluster.members.reduce(
    (acc, member) => acc + computeClusterMemberWeight(member, config),
    0,
  );
  // `assessment.d1WeightMultiplier` is the precomputed combined multiplier
  // from Phase 4: `significanceMultiplier × SA_WEIGHT_MULTIPLIERS[bucket]`.
  // For any eligible cluster, significanceMultiplier === 1.0 (qualified) and
  // the bucket is one of `full` / `discounted` / `low-sa-review`, so this
  // value is simply the §10 line-5 SA factor (range 0.3..1.0). Multiplying
  // through it preserves the spec algebra `members × cluster.saResonance`
  // while letting the Phase 4 single source of truth drive the math.
  const rawScore = memberSum * assessment.d1WeightMultiplier;

  return {
    clusterId: assessment.cluster.clusterId,
    rawScore,
    normalizedScore: 0, // filled by aggregateD1FromClusters
    eligible: true,
    signalCount: assessment.cluster.signalCount,
  };
}

/**
 * Aggregate per-cluster D1 scores into a deployment-level result with
 * normalised scores per §10 final line ("D1 is normalized across all active
 * clusters to [0, 1]").
 *
 * Normalisation divides each `rawScore` by the population max — keeps the
 * eligible cluster with the strongest demand at 1.0 and orders the rest
 * proportionally. When no clusters are eligible, all `normalizedScore` are 0
 * and `meanNormalizedScore` is 0 — D1 cleanly degrades to "no pipeline-derived
 * demand" without surfacing NaNs.
 *
 * `meanNormalizedScore` is the mean across **eligible** clusters only —
 * ineligible clusters (rawScore = 0) don't pull the population mean down.
 */
export function aggregateD1FromClusters(
  assessments: SignificanceAssessedCluster[],
  config: SignalIngestionConfig = DEFAULT_SIGNAL_INGESTION_CONFIG,
): AggregatedD1Result {
  const perCluster = assessments.map((a) => computeClusterD1(a, config));
  const eligibleScores = perCluster.filter((c) => c.eligible);

  const maxRawScore = eligibleScores.reduce((max, c) => Math.max(max, c.rawScore), 0);

  // Populate normalisedScore in-place. When maxRawScore is 0 (no eligible
  // clusters OR all eligible clusters had zero weight — possible if every
  // member has icpResonance × tierMultiplier × recencyDecay = 0), normalised
  // scores stay at 0 by short-circuiting.
  for (const c of perCluster) {
    c.normalizedScore = maxRawScore > 0 && c.eligible ? c.rawScore / maxRawScore : 0;
  }

  const meanNormalizedScore =
    eligibleScores.length > 0
      ? eligibleScores.reduce((sum, c) => sum + c.normalizedScore, 0) / eligibleScores.length
      : 0;

  return {
    clusters: perCluster,
    maxRawScore,
    meanNormalizedScore,
  };
}

// ── Non-replacement composition (§10.4 spirit; AC #2, #4, #5) ───────────────

/**
 * Blend signal-pipeline-derived demand with the existing backlog-item demand
 * input per RFC-0030 §10 non-replacement contract.
 *
 * **Backward compatibility (AC #4)**: when `config.enabled === false` the
 * function bypasses the pipeline entirely and returns `composedScore =
 * backlogItemD1` (or 0 when absent). `pipelineBypass = true` so callers /
 * tests can audit the bypass branch.
 *
 * **Weight balancing (AC #5)**: when both inputs are present and the pipeline
 * is enabled, weights from `config.d1Composition` are normalised to sum to 1
 * and applied as a linear blend. Negative weights are clamped to 0 by the
 * config validator; if both weights are 0 (operator misconfiguration), the
 * function falls back to the unweighted average to avoid emitting NaN.
 *
 * **Single-input cases**: when only one input is present, the other is
 * treated as 0; weights still apply so an operator who configured
 * `{signalPipelineWeight: 0.8, backlogItemWeight: 0.2}` and supplies only
 * `backlogItemD1` gets `0.2 × backlogItemD1` (which is documented behaviour —
 * the missing input is genuinely missing demand). If you want "use this one
 * unweighted when the other is absent" semantics, omit the absent field AND
 * set the other input's weight to 1.0.
 */
export function composeD1Inputs(args: ComposeD1InputsArgs): ComposedD1Result {
  const config = args.config ?? DEFAULT_SIGNAL_INGESTION_CONFIG;
  const backlog = args.backlogItemD1 ?? 0;
  const pipeline = args.signalPipelineD1 ?? 0;

  // Backward-compat fast path: pipeline disabled OR no pipeline input.
  if (!config.enabled || args.signalPipelineD1 === undefined) {
    return {
      composedScore: clamp01(backlog),
      signalPipelineWeightApplied: 0,
      backlogItemWeightApplied: 1,
      signalPipelineContribution: 0,
      backlogItemContribution: clamp01(backlog),
      pipelineBypass: true,
    };
  }

  const { signalPipelineWeightApplied, backlogItemWeightApplied } = normaliseWeights(
    config.d1Composition,
  );

  const pipelineContribution = pipeline * signalPipelineWeightApplied;
  const backlogContribution = backlog * backlogItemWeightApplied;
  const composedScore = clamp01(pipelineContribution + backlogContribution);

  return {
    composedScore,
    signalPipelineWeightApplied,
    backlogItemWeightApplied,
    signalPipelineContribution: pipelineContribution,
    backlogItemContribution: backlogContribution,
    pipelineBypass: false,
  };
}

/**
 * Normalise the configured weights so they sum to 1. When both are 0
 * (degenerate operator config), fall back to a 50/50 split so the function
 * never returns NaN downstream.
 */
function normaliseWeights(weights: D1CompositionWeights): {
  signalPipelineWeightApplied: number;
  backlogItemWeightApplied: number;
} {
  const sum = weights.signalPipelineWeight + weights.backlogItemWeight;
  if (sum <= 0) {
    return { signalPipelineWeightApplied: 0.5, backlogItemWeightApplied: 0.5 };
  }
  return {
    signalPipelineWeightApplied: weights.signalPipelineWeight / sum,
    backlogItemWeightApplied: weights.backlogItemWeight / sum,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

// ── PPA admission integration (AC #3) ───────────────────────────────────────

/**
 * Pluggable matcher: resolve a backlog work item to the most relevant cluster
 * D1 score (if any). Callers supply this so the cluster-to-item match policy
 * can be swapped per deployment without rewriting the core composition.
 *
 * v1 contract: the matcher receives a free-form `itemKey` (typically the
 * task title or a normalised slug); returns the best-matching `ClusterD1Score`
 * or `undefined` when no cluster is a meaningful match. The matcher is
 * intentionally NOT given write access to the score — it only chooses which
 * cluster the item maps onto. RFC-0024 capture matching wires this in v2.
 */
export interface ClusterMatcher {
  (itemKey: string, aggregated: AggregatedD1Result): ClusterD1Score | undefined;
}

/**
 * RFC-0008 PPA Triad integration helper — applies the composed D1 to a
 * `PriorityInput` so the admission composite consumes pipeline-derived
 * demand through the same `demandSignal` field it already reads.
 *
 * The returned object is a NEW `PriorityInput` (input is not mutated). When
 * the pipeline is disabled OR no cluster match exists, the returned object
 * carries the input's original `demandSignal` unchanged — backward-compatible
 * (AC #4).
 *
 * Composition algorithm:
 *   1. Resolve `signalPipelineD1` via `matcher(itemKey, aggregated)` →
 *      `match?.normalizedScore` (range [0, 1]); when matcher returns
 *      `undefined`, no pipeline contribution.
 *   2. Read `backlogItemD1` from `priorityInput.demandSignal` (already the
 *      output of `mapIssueToPriorityInput()` per existing path).
 *   3. Compose via `composeD1Inputs()` with the configured weights.
 *   4. Override `demandSignal` on a shallow clone of the input.
 *
 * The composed result and its audit fields are also returned so callers can
 * surface the pipeline contribution in pillar-breakdown logs.
 */
export interface EnrichDemandSignalArgs<T extends { demandSignal?: number }> {
  /** The PriorityInput-shaped object to enrich. NOT mutated. */
  priorityInput: T;
  /** A short key the matcher uses to find a cluster (title, slug, or item ID). */
  itemKey: string;
  /** The aggregation result from `aggregateD1FromClusters()`. */
  aggregated: AggregatedD1Result;
  /** Cluster-to-item matcher; see `ClusterMatcher` docstring. */
  matcher: ClusterMatcher;
  /** Signal ingestion config. Defaults to `DEFAULT_SIGNAL_INGESTION_CONFIG`. */
  config?: SignalIngestionConfig;
}

export interface EnrichDemandSignalResult<T> {
  /** The enriched PriorityInput (shallow clone with `demandSignal` overlaid). */
  enriched: T;
  /** Full composition result for audit / breakdown surfacing. */
  composition: ComposedD1Result;
  /** Which cluster matched, when any. `undefined` when matcher returned none. */
  matchedCluster: ClusterD1Score | undefined;
}

export function enrichDemandSignalFromClusters<T extends { demandSignal?: number }>(
  args: EnrichDemandSignalArgs<T>,
): EnrichDemandSignalResult<T> {
  const config = args.config ?? DEFAULT_SIGNAL_INGESTION_CONFIG;
  const matchedCluster = args.matcher(args.itemKey, args.aggregated);
  const signalPipelineD1 = matchedCluster?.normalizedScore;
  const backlogItemD1 = args.priorityInput.demandSignal;

  const composition = composeD1Inputs({ signalPipelineD1, backlogItemD1, config });

  const enriched: T = {
    ...args.priorityInput,
    demandSignal: composition.composedScore,
  };

  return { enriched, composition, matchedCluster };
}
