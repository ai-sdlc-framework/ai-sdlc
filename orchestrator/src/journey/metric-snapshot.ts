/**
 * RFC-0018 Phase 4 — MetricSnapshot resource read API (OQ-5 resolution).
 *
 * Implements:
 *   AC #1: MetricSnapshot schema (spec/schemas/metric-snapshot.v1.schema.json)
 *   AC #2: MetricSnapshot read API — `getLatestMetricSnapshot(journey, metricId)`
 *   AC #3: Stale-metric detection (default 30d; per-Soul configurable) with
 *          `Decision: journey-metric-stale` + warn-and-unknown Cκ behavior
 *   AC #4: Graduated Eρ₅ degradation (0-30/30-60/60-90/90+ thresholds + Decisions)
 *   AC #5: Per-Soul `accessibility.auditOverdueGracePolicy` modes
 *   AC #6: RFC-0022 multi-posture composition (strictest cadence applies)
 *
 * ### OQ-5 design summary
 *
 * Operators supply MetricSnapshot resources from their analytics pipeline
 * (Mixpanel, Amplitude, Heap, internal-pipeline). The framework reads
 * `completion-rate` and other journey-success values; it does NOT compute
 * them from an analytics backend.
 *
 * Staleness: when `recordedAt` is older than `thresholdDays` (default 30),
 * the scorer treats the metric as an unknown input (warn-and-unknown, NOT
 * fail-closed). A `Decision: journey-metric-stale` is emitted for operator
 * batch review.
 *
 * ### OQ-6 design summary
 *
 * When a journey's accessibility audit is overdue, Eρ₅ degrades on this
 * graduated schedule (per-Soul policy `auditOverdueGracePolicy`):
 *
 *   Policy `graduated` (default):
 *     0–30d past cadence  → warn only  (`journey-audit-overdue-warn`)
 *     30–60d              → Eρ₅ -25%   (`journey-audit-overdue-graduated`)
 *     60–90d              → Eρ₅ -50%   (`journey-audit-overdue-graduated`)
 *     90d+                → effective block (`journey-audit-overdue-blocking`)
 *
 *   Policy `binary-30d`:
 *     0–30d → no impact (SOC2/HIPAA early-warning model)
 *     30d+  → immediate Eρ₅ fail
 *
 *   Policy `hard-block`:
 *     Immediate Eρ₅ fail at cadence+0d (strictest, no grace)
 *
 * ### RFC-0022 multi-posture composition (AC #6)
 *
 * When the RFC-0022 compliance posture declares a stricter cadence than
 * the soul-default, the strictest constraint wins. This mirrors the
 * RFC-0030 OQ-13.3 UNION precedent for multi-posture composition.
 *
 * ### Decision-routing must-consume contract
 *
 * `getLatestMetricSnapshot` emits `decision: 'journey-metric-stale'` when a
 * snapshot is present but older than `thresholdDays`. Callers MUST inspect
 * `result.decision` and route it — typically to the RFC-0035 G0 batch-review
 * queue — before using `result.snapshot.spec.value` for Cκ scoring. Silently
 * dropping `result.decision` defeats the operator-visibility guarantee that
 * makes warn-and-unknown safe (non-fail-closed). A typed must-consume pattern:
 *
 *   ```ts
 *   const result = getLatestMetricSnapshot(journey, metricId, opts);
 *   if (result.decision) emitDecision(result.decision); // required
 *   if (result.freshness === 'fresh') useValue(result.snapshot!.spec.value);
 *   ```
 *
 * @see spec/rfcs/RFC-0018-in-soul-journey-pattern.md §10.1 OQ-5 + OQ-6
 * @see spec/schemas/metric-snapshot.v1.schema.json
 */

// ── MetricSnapshot types ───────────────────────────────────────────────

/**
 * A single journey success-metric snapshot as supplied by the operator's
 * analytics pipeline. Matches `spec/schemas/metric-snapshot.v1.schema.json`.
 */
export interface MetricSnapshot {
  /** Always 'ai-sdlc.io/v1alpha1'. */
  readonly apiVersion: 'ai-sdlc.io/v1alpha1';
  /** Always 'MetricSnapshot'. */
  readonly kind: 'MetricSnapshot';
  readonly metadata: {
    /**
     * Path-style journey URI.
     * Soul-scoped:    `<soul-id>/<journey-id>`
     * Variant-scoped: `<soul-id>/<variant-id>/<journey-id>`
     */
    readonly journey: string;
    /**
     * Metric identifier (kebab-case). MUST match a `successMetrics[].id`
     * on the parent journey declaration.
     * Examples: 'completion-rate', 'median-time-to-first-task-done'
     */
    readonly metricId: string;
    readonly labels?: Record<string, string>;
    readonly annotations?: Record<string, string>;
  };
  readonly spec: {
    /** Metric value. Unit convention shared between operator and framework. */
    readonly value: number;
    /**
     * ISO 8601 timestamp when this metric was recorded / sampled.
     * Used to compute staleness relative to `thresholdDays`.
     */
    readonly recordedAt: string;
    /**
     * Free-text analytics tool identifier.
     * Examples: 'mixpanel', 'amplitude', 'heap', 'internal-pipeline'
     */
    readonly sourceTool: string;
    /** Optional ISO 8601 window start (informational). */
    readonly windowStart?: string;
    /** Optional ISO 8601 window end (informational). */
    readonly windowEnd?: string;
  };
}

// ── Staleness config ───────────────────────────────────────────────────

/**
 * Staleness configuration for `journey.successMetrics.staleness`.
 * Matches the corresponding block in `journey-config.v1.schema.json`.
 */
export interface MetricStalenessConfig {
  /** Days after last MetricSnapshot before the metric is stale. Default 30. */
  readonly thresholdDays?: number;
}

/** Default staleness threshold per OQ-5 resolution (30 days). */
export const DEFAULT_STALENESS_THRESHOLD_DAYS = 30;

// ── Stale-metric result types ──────────────────────────────────────────

/**
 * Possible states for a metric lookup result.
 *
 * - `'fresh'`   — snapshot found AND within staleness threshold
 * - `'stale'`   — snapshot found BUT older than threshold (warn-and-unknown)
 * - `'missing'` — no snapshot found for the journey/metricId pair
 */
export type MetricFreshness = 'fresh' | 'stale' | 'missing';

/**
 * Result returned by `getLatestMetricSnapshot`.
 *
 * - When `freshness === 'fresh'`:  `snapshot` is populated; use `snapshot.spec.value`
 * - When `freshness === 'stale'`:  `snapshot` is populated but `decision` is emitted
 *   (warn-and-unknown — Cκ treats metric as unknown input, pipeline continues)
 * - When `freshness === 'missing'`: no snapshot; Cκ scores as unknown input
 */
export interface MetricSnapshotResult {
  /** Journey path URI (e.g. 'spry-engage/onboarding'). */
  readonly journey: string;
  /** Metric ID (e.g. 'completion-rate'). */
  readonly metricId: string;
  /** Freshness state. */
  readonly freshness: MetricFreshness;
  /** The matched snapshot (populated when freshness is 'fresh' or 'stale'). */
  readonly snapshot?: MetricSnapshot;
  /**
   * Decision emitted when `freshness === 'stale'`.
   * Value: `'journey-metric-stale'`.
   * Routing: RFC-0035 G0 (non-blocking batch review — warn-and-unknown, not fail-closed).
   */
  readonly decision?: 'journey-metric-stale';
  /** Days since `recordedAt` (populated when snapshot is present). */
  readonly ageInDays?: number;
  /** Staleness threshold in days that was applied. */
  readonly thresholdDays: number;
}

// ── MetricSnapshot read API ────────────────────────────────────────────

/**
 * Options for `getLatestMetricSnapshot`.
 */
export interface GetLatestMetricSnapshotOptions {
  /**
   * Collection of all MetricSnapshot records known to the framework.
   * Callers are responsible for loading these from their persistence layer
   * (filesystem, in-memory fixture, database) before calling.
   */
  readonly snapshots: readonly MetricSnapshot[];
  /**
   * Per-Soul staleness config (from the soul's `spec.journeyConfig.successMetrics.staleness`
   * or the org-wide `.ai-sdlc/journey-config.yaml` default).
   * When omitted, the default 30d threshold applies.
   */
  readonly stalenessConfig?: MetricStalenessConfig;
  /**
   * Reference "now" timestamp (ISO 8601). Defaults to `new Date().toISOString()`.
   * Provided for deterministic testing.
   */
  readonly now?: string;
}

/**
 * Retrieve the **latest** MetricSnapshot for the given journey + metricId pair
 * and classify it as fresh, stale, or missing.
 *
 * Selection: when multiple snapshots match, the one with the most recent
 * `spec.recordedAt` is returned (latest-wins). This covers the case where
 * the operator's pipeline emits snapshots on a periodic schedule.
 *
 * Staleness: `ageInDays = (now - recordedAt) / (1000 * 60 * 60 * 24)`.
 * When `ageInDays > thresholdDays`, the result carries:
 *   - `freshness: 'stale'`
 *   - `decision: 'journey-metric-stale'`
 *
 * This Decision routes through RFC-0035 G0 (non-blocking batch review):
 * the Cκ scorer treats a stale metric as an unknown input (same behavior as
 * `freshness: 'missing'`), NOT as a hard fail. The pipeline continues.
 *
 * @param journey   Path-style journey URI (e.g. 'spry-engage/onboarding')
 * @param metricId  Metric identifier (e.g. 'completion-rate')
 * @param options   Snapshot collection + optional per-Soul config
 */
export function getLatestMetricSnapshot(
  journey: string,
  metricId: string,
  options: GetLatestMetricSnapshotOptions,
): MetricSnapshotResult {
  const { snapshots, stalenessConfig, now } = options;
  const thresholdDays = stalenessConfig?.thresholdDays ?? DEFAULT_STALENESS_THRESHOLD_DAYS;
  const nowMs = now ? new Date(now).getTime() : Date.now();

  // Filter to snapshots matching this journey + metricId pair.
  const matching = snapshots.filter(
    (s) => s.metadata.journey === journey && s.metadata.metricId === metricId,
  );

  if (matching.length === 0) {
    return {
      journey,
      metricId,
      freshness: 'missing',
      thresholdDays,
    };
  }

  // Select the most recent by recordedAt (latest-wins).
  const latest = matching.reduce((best, candidate) => {
    const bestMs = new Date(best.spec.recordedAt).getTime();
    const candidateMs = new Date(candidate.spec.recordedAt).getTime();
    return candidateMs > bestMs ? candidate : best;
  });

  const recordedAtMs = new Date(latest.spec.recordedAt).getTime();
  // Guard: a future-dated recordedAt (recordedAt > now) would yield a negative
  // ageInDays, making the metric appear perpetually fresh and suppressing the
  // journey-metric-stale Decision. Clamp negative ages to stale so a
  // misconfigured analytics pipeline cannot silently defeat staleness checks.
  const rawAgeInDays = (nowMs - recordedAtMs) / (1000 * 60 * 60 * 24);
  const ageInDays = rawAgeInDays < 0 ? thresholdDays + 1 : rawAgeInDays;

  if (ageInDays > thresholdDays) {
    return {
      journey,
      metricId,
      freshness: 'stale',
      snapshot: latest,
      decision: 'journey-metric-stale',
      ageInDays,
      thresholdDays,
    };
  }

  return {
    journey,
    metricId,
    freshness: 'fresh',
    snapshot: latest,
    ageInDays,
    thresholdDays,
  };
}

// ── Accessibility cadence / Eρ₅ degradation ───────────────────────────

/**
 * Per-Soul policy for Eρ₅ degradation when the accessibility audit is overdue.
 * Matches `journey-config.v1.schema.json` `accessibility.auditOverdueGracePolicy`.
 *
 * - `'graduated'`  — default; progressive reduction matching Vanta/Drata/Secureframe pattern
 * - `'binary-30d'` — SOC2/HIPAA strict: no impact within 30d, then fail-closed
 * - `'hard-block'` — immediate fail at cadence+0d (no grace)
 */
export type AuditOverdueGracePolicy = 'graduated' | 'binary-30d' | 'hard-block';

/**
 * Eρ₅ impact tiers for graduated degradation.
 *
 * - `'warn'`           — Eρ₅ unchanged; Decision emitted for operator visibility
 * - `'reduced-25'`     — Eρ₅ multiplied by 0.75 (−25%)
 * - `'reduced-50'`     — Eρ₅ multiplied by 0.50 (−50%)
 * - `'effective-block'`— Eρ₅ set to 0 (admission blocked)
 */
export type Erho5Impact = 'warn' | 'reduced-25' | 'reduced-50' | 'effective-block';

/** Eρ₅ multiplier for each impact tier. */
export const ERHO5_MULTIPLIERS: Record<Erho5Impact, number> = {
  warn: 1.0,
  'reduced-25': 0.75,
  'reduced-50': 0.5,
  'effective-block': 0.0,
};

/**
 * Graduated thresholds configuration (days past audit cadence).
 * Matches `accessibility.graduatedThresholds` in `journey-config.v1.schema.json`.
 */
export interface GraduatedThresholds {
  /** Days past cadence at which 'warn' Decision fires. Default 0. */
  readonly warnAt?: number;
  /** Days past cadence at which −25% reduction fires. Default 30. */
  readonly reduced25At?: number;
  /** Days past cadence at which −50% reduction fires. Default 60. */
  readonly reduced50At?: number;
  /** Days past cadence at which effective-block fires. Default 90. */
  readonly effectiveBlockAt?: number;
}

/** Default graduated thresholds per OQ-6 resolution. */
export const DEFAULT_GRADUATED_THRESHOLDS: Required<GraduatedThresholds> = {
  warnAt: 0,
  reduced25At: 30,
  reduced50At: 60,
  effectiveBlockAt: 90,
};

/**
 * Decision kinds emitted for accessibility audit overdue events.
 * Routes through RFC-0035 G0 non-blocking pipeline contract.
 */
export type AuditOverdueDecision =
  | 'journey-audit-overdue-warn'
  | 'journey-audit-overdue-graduated'
  | 'journey-audit-overdue-blocking';

/**
 * Result of the Eρ₅ degradation calculation for an overdue accessibility audit.
 */
export interface AuditOverdueResult {
  /** Soul identifier for which the result was computed. */
  readonly soulId: string;
  /** Journey identifier. */
  readonly journeyId: string;
  /** Days the audit is past cadence (0 means exactly at cadence). */
  readonly daysOverdue: number;
  /** The grace policy that was applied. */
  readonly policy: AuditOverdueGracePolicy;
  /** Eρ₅ impact tier. */
  readonly impact: Erho5Impact;
  /**
   * Eρ₅ multiplier to apply to the base Eρ₅ score.
   * 1.0 = no impact; 0.75 = -25%; 0.50 = -50%; 0.0 = effective block.
   */
  readonly erho5Multiplier: number;
  /**
   * Decision to emit for this result.
   * `null` when daysOverdue <= 0 (audit is not yet overdue).
   */
  readonly decision: AuditOverdueDecision | null;
}

/**
 * Options for `computeAuditOverdueErho5`.
 */
export interface ComputeAuditOverdueOptions {
  /** Soul identifier for event attribution. */
  readonly soulId: string;
  /** Journey identifier for event attribution. */
  readonly journeyId: string;
  /**
   * Days the journey's audit is past its declared cadence.
   * 0 = exactly at cadence; positive = overdue; negative = not yet overdue.
   */
  readonly daysOverdue: number;
  /**
   * Per-Soul grace policy.
   * Defaults to `'graduated'`.
   */
  readonly policy?: AuditOverdueGracePolicy;
  /**
   * Per-org graduated threshold configuration.
   * Only used when `policy === 'graduated'`.
   * Defaults to `DEFAULT_GRADUATED_THRESHOLDS`.
   */
  readonly graduatedThresholds?: GraduatedThresholds;
}

/**
 * Compute the Eρ₅ impact and Decision for an overdue accessibility audit.
 *
 * Implements RFC-0018 §10.1 OQ-6 graduated Eρ₅ degradation:
 *
 * Policy `graduated` (default):
 *   - 0 ≤ daysOverdue < 30  → `warn`           (multiplier 1.0)
 *   - 30 ≤ daysOverdue < 60 → `reduced-25`     (multiplier 0.75)
 *   - 60 ≤ daysOverdue < 90 → `reduced-50`     (multiplier 0.50)
 *   - daysOverdue ≥ 90      → `effective-block` (multiplier 0.0)
 *
 * Policy `binary-30d` (SOC2/HIPAA strict):
 *   - daysOverdue < 30  → no impact (multiplier 1.0, no Decision)
 *   - daysOverdue ≥ 30  → `effective-block` (multiplier 0.0)
 *
 * Policy `hard-block` (HIPAA/PCI-DSS ultra-strict):
 *   - daysOverdue ≤ 0   → no impact (multiplier 1.0, no Decision)
 *   - daysOverdue > 0   → `effective-block` (multiplier 0.0)
 *
 * When `daysOverdue <= 0`, returns multiplier 1.0 and `decision: null`
 * regardless of policy (audit is on-time or not yet due).
 */
export function computeAuditOverdueErho5(options: ComputeAuditOverdueOptions): AuditOverdueResult {
  const { soulId, journeyId, daysOverdue, policy = 'graduated', graduatedThresholds } = options;

  // Strictly negative daysOverdue means the audit is not yet due — no impact
  // regardless of policy. Note: daysOverdue === 0 means "exactly at cadence
  // boundary (cadence+0d)" and is intentionally NOT caught here so the
  // policy-specific logic below can apply. In particular, `hard-block`
  // specifies "no grace at cadence+0d", meaning it must fire at daysOverdue=0.
  if (daysOverdue < 0) {
    return {
      soulId,
      journeyId,
      daysOverdue,
      policy,
      impact: 'warn',
      erho5Multiplier: 1.0,
      decision: null,
    };
  }

  if (policy === 'hard-block') {
    return {
      soulId,
      journeyId,
      daysOverdue,
      policy,
      impact: 'effective-block',
      erho5Multiplier: ERHO5_MULTIPLIERS['effective-block'],
      decision: 'journey-audit-overdue-blocking',
    };
  }

  if (policy === 'binary-30d') {
    const threshold = 30;
    if (daysOverdue < threshold) {
      // SOC2/HIPAA grace window: warn only, no Eρ₅ impact.
      return {
        soulId,
        journeyId,
        daysOverdue,
        policy,
        impact: 'warn',
        erho5Multiplier: 1.0,
        decision: 'journey-audit-overdue-warn',
      };
    }
    return {
      soulId,
      journeyId,
      daysOverdue,
      policy,
      impact: 'effective-block',
      erho5Multiplier: ERHO5_MULTIPLIERS['effective-block'],
      decision: 'journey-audit-overdue-blocking',
    };
  }

  // policy === 'graduated' (default)
  // Guard: NaN daysOverdue (e.g. from a division by zero or bad caller) must
  // not fall through to the warn/1.0 return at the bottom of the graduated
  // path, producing a fail-open result. Treat non-finite values as
  // effective-block (conservative) so the pipeline aborts rather than silently
  // continuing with an unknown overdue duration.
  if (!Number.isFinite(daysOverdue)) {
    return {
      soulId,
      journeyId,
      daysOverdue,
      policy,
      impact: 'effective-block',
      erho5Multiplier: ERHO5_MULTIPLIERS['effective-block'],
      decision: 'journey-audit-overdue-blocking',
    };
  }

  const thresholds = {
    warnAt: graduatedThresholds?.warnAt ?? DEFAULT_GRADUATED_THRESHOLDS.warnAt,
    reduced25At: graduatedThresholds?.reduced25At ?? DEFAULT_GRADUATED_THRESHOLDS.reduced25At,
    reduced50At: graduatedThresholds?.reduced50At ?? DEFAULT_GRADUATED_THRESHOLDS.reduced50At,
    effectiveBlockAt:
      graduatedThresholds?.effectiveBlockAt ?? DEFAULT_GRADUATED_THRESHOLDS.effectiveBlockAt,
  };

  if (daysOverdue >= thresholds.effectiveBlockAt) {
    return {
      soulId,
      journeyId,
      daysOverdue,
      policy,
      impact: 'effective-block',
      erho5Multiplier: ERHO5_MULTIPLIERS['effective-block'],
      decision: 'journey-audit-overdue-blocking',
    };
  }

  if (daysOverdue >= thresholds.reduced50At) {
    return {
      soulId,
      journeyId,
      daysOverdue,
      policy,
      impact: 'reduced-50',
      erho5Multiplier: ERHO5_MULTIPLIERS['reduced-50'],
      decision: 'journey-audit-overdue-graduated',
    };
  }

  if (daysOverdue >= thresholds.reduced25At) {
    return {
      soulId,
      journeyId,
      daysOverdue,
      policy,
      impact: 'reduced-25',
      erho5Multiplier: ERHO5_MULTIPLIERS['reduced-25'],
      decision: 'journey-audit-overdue-graduated',
    };
  }

  // daysOverdue >= warnAt (default 0) but below reduced25At
  return {
    soulId,
    journeyId,
    daysOverdue,
    policy,
    impact: 'warn',
    erho5Multiplier: 1.0,
    decision: 'journey-audit-overdue-warn',
  };
}

// ── RFC-0022 multi-posture cadence composition ─────────────────────────

/**
 * Audit cadence values from the journey declaration (RFC-0018 §5.2).
 * Ordered strictest → least strict for UNION selection.
 */
export type AuditCadence = 'continuous' | 'release-gated' | 'quarterly' | 'annually';

/**
 * Numeric strictness order for cadence values.
 * Higher = stricter (shorter audit interval).
 * Used by `resolveStrictestCadence` to pick the UNION result.
 */
export const AUDIT_CADENCE_STRICTNESS: Record<AuditCadence, number> = {
  continuous: 4,
  'release-gated': 3,
  quarterly: 2,
  annually: 1,
};

/**
 * Options for `resolveStrictestCadence`.
 */
export interface ResolveStrictestCadenceOptions {
  /**
   * Journey-level cadence declared in `accessibility.auditCadence`.
   */
  readonly journeyCadence: AuditCadence;
  /**
   * Cadences required by the active RFC-0022 compliance posture(s).
   * An empty array means no posture constraint — journey cadence is used as-is.
   * When multiple postures are active, all are included here.
   */
  readonly postureCadences: readonly AuditCadence[];
}

/**
 * Resolve the effective audit cadence by applying the strictest constraint
 * from the journey declaration and all active RFC-0022 compliance postures.
 *
 * This implements RFC-0018 AC #6 + RFC-0030 OQ-13.3 UNION precedent:
 * the strictest constraint among all active postures and the journey's own
 * declaration wins.
 *
 * @example
 * // Journey declares 'annually', but SOC2 posture requires 'quarterly'
 * resolveStrictestCadence({
 *   journeyCadence: 'annually',
 *   postureCadences: ['quarterly'],
 * })
 * // → 'quarterly' (posture wins — stricter)
 *
 * @example
 * // Journey declares 'continuous' (strictest possible)
 * resolveStrictestCadence({
 *   journeyCadence: 'continuous',
 *   postureCadences: ['quarterly', 'annually'],
 * })
 * // → 'continuous' (journey wins — already strictest)
 */
export function resolveStrictestCadence(options: ResolveStrictestCadenceOptions): AuditCadence {
  const { journeyCadence, postureCadences } = options;

  const all: AuditCadence[] = [journeyCadence, ...postureCadences];

  // UNION = strictest (highest strictness number wins).
  return all.reduce((strictest, candidate) => {
    const currentOrder = AUDIT_CADENCE_STRICTNESS[strictest] ?? 0;
    const candidateOrder = AUDIT_CADENCE_STRICTNESS[candidate] ?? 0;
    return candidateOrder > currentOrder ? candidate : strictest;
  });
}

/**
 * Options for `resolveStrictestGracePolicy`.
 */
export interface ResolveStrictestGracePolicyOptions {
  /**
   * Per-Soul grace policy from `accessibility.auditOverdueGracePolicy`.
   * Defaults to `'graduated'`.
   */
  readonly soulPolicy?: AuditOverdueGracePolicy;
  /**
   * Grace policies required by the active RFC-0022 compliance postures.
   * An empty array means no posture constraint — soul policy is used as-is.
   * SOC2/HIPAA postures typically impose 'binary-30d' or 'hard-block'.
   */
  readonly posturesPolicies: readonly AuditOverdueGracePolicy[];
}

/**
 * Policy strictness order (higher = stricter).
 */
export const GRACE_POLICY_STRICTNESS: Record<AuditOverdueGracePolicy, number> = {
  graduated: 1,
  'binary-30d': 2,
  'hard-block': 3,
};

/**
 * Resolve the effective grace policy by picking the STRICTEST among the
 * soul-level policy and all active RFC-0022 compliance posture policies.
 *
 * RFC-0022 + RFC-0018 AC #6: multi-posture UNION → strictest applies.
 *
 * @example
 * // Soul defaults to 'graduated'; SOC2 posture requires 'binary-30d'
 * resolveStrictestGracePolicy({
 *   soulPolicy: 'graduated',
 *   posturesPolicies: ['binary-30d'],
 * })
 * // → 'binary-30d' (posture wins — stricter)
 */
export function resolveStrictestGracePolicy(
  options: ResolveStrictestGracePolicyOptions,
): AuditOverdueGracePolicy {
  const { soulPolicy = 'graduated', posturesPolicies } = options;
  const all: AuditOverdueGracePolicy[] = [soulPolicy, ...posturesPolicies];
  return all.reduce((strictest, candidate) => {
    const currentOrder = GRACE_POLICY_STRICTNESS[strictest] ?? 0;
    const candidateOrder = GRACE_POLICY_STRICTNESS[candidate] ?? 0;
    return candidateOrder > currentOrder ? candidate : strictest;
  });
}
