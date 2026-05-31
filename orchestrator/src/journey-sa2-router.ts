/**
 * RFC-0018 Phase 2 — In-Soul Journey Pattern admission scorer composition.
 *
 * Implements the journey-scope routing algorithm described in RFC-0018 §5.4
 * and §10.1 (OQ-4 resolution):
 *
 *   resolveTargetedJourneys(w) = set of (soulId, [variantId,] journeyId) triples
 *     declared on the work item via `targetedJourneys[]` (URI shapes
 *     `<soul-id>/<journey-id>` or `<soul-id>/<variant-id>/<journey-id>`).
 *
 *   If no `targetedJourneys` declared:
 *     Scoring proceeds at soul/variant scope (backward-compatible — unchanged
 *     from RFC-0009 + RFC-0017 baseline).
 *
 *   Else if |targeted| == 1 (single-journey):
 *     Sα₂(w) = scoreSα₂(journey.designImperatives UNION variant's UNION soul's;
 *              most-specific wins: journey > variant > soul)
 *     Cκ(w)  = boosted when journey.successMetrics.completion-rate < alertBelow
 *     Eρ₅(w) = elevated when journey.accessibility.wcagLevel > soul/variant default
 *
 *   Else (multi-journey):
 *     Per-journey scores aggregated via `crossJourneyAggregation` config
 *     (default `min` per RFC-0018 §5.4 + RFC-0017 OQ-4 cross-variant pattern).
 *
 * ### Completion-criteria closed enum (OQ-4 resolution)
 *
 * v1 allows only: `terminal-success-state` | `all-states-reached`
 * `custom-predicate` is rejected at schema validation time.
 * Future activation via `Decision: journey-custom-predicate-activation-request`
 * (Stage A counter, auto-promote at ≥2 distinct adopter requests).
 * Future language: CEL (Google Common Expression Language) per OQ-4 resolution.
 *
 * ### Backward compatibility
 *
 * Work items without `targetedJourneys` score against soul / variant (existing
 * RFC-0017 behavior preserved). Soul DIDs without `journeys[]` behave identically.
 *
 * @see spec/rfcs/RFC-0018-in-soul-journey-pattern.md §5.4 + §10 + §10.1
 * @see orchestrator/src/variant-admission.ts — sibling RFC-0017 Phase 2 router
 * @see orchestrator/src/compliance-clearance.ts — Eρ₅ base scorer
 */

// ── Completion-criteria closed enum (OQ-4 v1) ──────────────────────────

/**
 * v1 closed enum for completion-criteria `kind` per RFC-0018 OQ-4 resolution
 * (2026-05-28, full rubric).
 *
 * `custom-predicate` is intentionally absent — schema validation MUST reject
 * it. Future RFC will activate it via the Decision Catalog with CEL as the
 * recommended expression language.
 */
export type CompletionCriteriaKind = 'terminal-success-state' | 'all-states-reached';

/**
 * The set of valid v1 completion-criteria kind values.
 * Used by `validateCompletionCriteriaKind` for closed-enum rejection.
 */
export const COMPLETION_CRITERIA_V1_KINDS: ReadonlySet<CompletionCriteriaKind> = new Set([
  'terminal-success-state',
  'all-states-reached',
]);

/**
 * Decision kind for the `custom-predicate` activation request counter.
 * Stage A counter per RFC-0035 G0 non-blocking contract.
 * Auto-promotes at ≥2 distinct adopter requests (RFC-0018 OQ-4 resolution).
 */
export const JOURNEY_CUSTOM_PREDICATE_DECISION_KIND =
  'journey-custom-predicate-activation-request' as const;

/**
 * Result of validating a completion-criteria `kind` value against the v1 closed enum.
 */
export interface CompletionCriteriaValidationResult {
  /** True when the kind value is in the v1 closed enum. */
  valid: boolean;
  /**
   * When `valid === false`, the rejected kind string (e.g. `'custom-predicate'`).
   * Used for diagnostics + Decision counter registration.
   */
  rejectedKind?: string;
  /**
   * When `valid === false` AND the rejected kind is `'custom-predicate'`,
   * the Decision kind to emit to the catalog (Stage A counter).
   */
  decisionKind?: typeof JOURNEY_CUSTOM_PREDICATE_DECISION_KIND;
}

/**
 * Validate a completion-criteria `kind` value against the v1 closed enum.
 *
 * Returns `{ valid: true }` for `terminal-success-state` and `all-states-reached`.
 * Returns `{ valid: false, rejectedKind, decisionKind }` for `custom-predicate`
 * (or any other unrecognized value). The caller is responsible for emitting the
 * Decision event to the RFC-0035 catalog.
 */
export function validateCompletionCriteriaKind(kind: string): CompletionCriteriaValidationResult {
  if (COMPLETION_CRITERIA_V1_KINDS.has(kind as CompletionCriteriaKind)) {
    return { valid: true };
  }
  const result: CompletionCriteriaValidationResult = {
    valid: false,
    rejectedKind: kind,
  };
  // Wire the Decision counter for custom-predicate specifically (OQ-4 auto-promote mechanism)
  if (kind === 'custom-predicate') {
    result.decisionKind = JOURNEY_CUSTOM_PREDICATE_DECISION_KIND;
  }
  return result;
}

// ── Decision counter (RFC-0035 Stage A) ─────────────────────────────────

/**
 * In-memory Stage A counter for `journey-custom-predicate-activation-request`.
 *
 * Per RFC-0018 OQ-4 resolution: auto-promote to a decision walkthrough at ≥2
 * distinct adopter requests. The counter tracks (adopter-id, feature-id) pairs
 * to deduplicate requests from the same adopter — "2 distinct adopter requests"
 * means 2 different adopter IDs, not 2 calls from the same adopter.
 *
 * In v1 this is an in-memory counter (reset per process). Phase 2 will persist
 * it via the RFC-0035 Decision Catalog `cli-decisions` surface (AISDLC-463).
 */
export interface DecisionCounter {
  /** The RFC-0035 decision kind being counted. */
  decisionKind: typeof JOURNEY_CUSTOM_PREDICATE_DECISION_KIND;
  /**
   * Deduplicated adopter IDs that have submitted a request.
   * When `size >= 2`, the counter has crossed the auto-promote threshold.
   */
  distinctAdopterIds: Set<string>;
  /** Total raw request count (including duplicates from same adopter). */
  totalRequests: number;
  /** Whether the auto-promote threshold (≥2 distinct adopters) has been crossed. */
  shouldAutoPromote: boolean;
}

/**
 * Increment the Stage A counter for a `journey-custom-predicate-activation-request`.
 *
 * @param counter    - The counter to increment (mutated in-place).
 * @param adopterId  - Adopter ID submitting the request (for deduplication).
 *                     Use `'__unknown__'` when adopter identity is unavailable.
 */
export function incrementDecisionCounter(counter: DecisionCounter, adopterId: string): void {
  counter.totalRequests++;
  counter.distinctAdopterIds.add(adopterId);
  counter.shouldAutoPromote = counter.distinctAdopterIds.size >= 2;
}

/**
 * Create a fresh Stage A counter for `journey-custom-predicate-activation-request`.
 */
export function createCustomPredicateDecisionCounter(): DecisionCounter {
  return {
    decisionKind: JOURNEY_CUSTOM_PREDICATE_DECISION_KIND,
    distinctAdopterIds: new Set(),
    totalRequests: 0,
    shouldAutoPromote: false,
  };
}

// ── WCAG level ordering (RFC-0018 §5.3 + §5.4 Eρ₅ elevation) ───────────

/**
 * WCAG conformance levels in ascending strictness order.
 * Used for journey-vs-soul WCAG comparison (Eρ₅ elevation).
 */
export type WcagLevel = 'A' | 'AA' | 'AAA';

/**
 * Ordinal index for WCAG levels — higher = stricter.
 * `A` < `AA` < `AAA`.
 */
const WCAG_LEVEL_ORDER: Record<WcagLevel, number> = {
  A: 0,
  AA: 1,
  AAA: 2,
};

/**
 * Returns true when `journeyLevel` is strictly ABOVE `soulDefault`.
 * Journeys MAY raise the WCAG level above the parent; they MAY NOT lower it.
 */
export function isWcagElevated(journeyLevel: WcagLevel, soulDefault: WcagLevel): boolean {
  return WCAG_LEVEL_ORDER[journeyLevel] > WCAG_LEVEL_ORDER[soulDefault];
}

// ── Journey declarations (mirror RFC-0018 §6.1 schema) ──────────────────

/**
 * A single success metric declared on a Journey.
 * Feeds Cκ (Capability Coverage) scoring at journey scope.
 */
export interface JourneySuccessMetric {
  /** Metric identifier (e.g. `'completion-rate'`, `'median-time-to-first-task-done'`). */
  id: string;
  /** Target value (e.g. `0.65` for 65% completion rate). */
  target?: number;
  /** Alert threshold: when current value drops below this, Cκ boost applies. */
  alertBelow?: number;
  /** Alert threshold: when current value rises above this, signal fires. */
  alertAbove?: number;
  /** Target seconds (for time-based metrics). */
  targetSeconds?: number;
}

/**
 * Accessibility requirements for a Journey (RFC-0018 §5.2).
 * Journey WCAG level may be set HIGHER than the soul floor.
 */
export interface JourneyAccessibility {
  wcagLevel: WcagLevel;
  wcagVersion: '2.0' | '2.1' | '2.2' | '3.0';
  conformanceTarget: number;
  auditCadence?: 'quarterly' | 'annually' | 'release-gated' | 'continuous';
}

/**
 * Completion criteria for a Journey (v1 closed enum per OQ-4).
 * `kind` MUST be `terminal-success-state` or `all-states-reached`.
 * `custom-predicate` is rejected at schema validation; see `validateCompletionCriteriaKind`.
 */
export interface JourneyCompletionCriteria {
  kind: CompletionCriteriaKind;
  /** Required when `kind === 'terminal-success-state'`. */
  target?: string;
}

/**
 * In-memory representation of one Journey declared on a Soul DID or Variant,
 * parallel to the YAML/JSON schema fields in RFC-0018 §6.1.
 *
 * Phase 1 (AISDLC-465) ships the schema; Phase 2 (this file) defines the
 * in-memory shape the admission composite needs for journey-scope routing.
 */
export interface JourneyDeclaration {
  /** Journey identifier (kebab-case, unique within parent scope). */
  id: string;
  /**
   * Journey scope: applies to all variants (`'soul'`) or a specific variant
   * (`'variant:<variant-id>'`).
   */
  scope: 'soul' | `variant:${string}`;
  /** v1 closed-enum completion criteria. */
  completionCriteria: JourneyCompletionCriteria;
  /** Accessibility requirements; wcagLevel may exceed soul floor. */
  accessibility: JourneyAccessibility;
  /** Journey-scoped success metrics. Feeds Cκ scoring. */
  successMetrics?: JourneySuccessMetric[];
  /** Journey-scoped design imperatives. UNION with variant/soul; most-specific wins. */
  designImperatives?: string[];
}

// ── Per-journey scoring inputs ───────────────────────────────────────────

/**
 * Pre-computed scores for a single Journey.
 * The journey-scope router uses these when computing Sα₂ + Cκ + Eρ₅.
 *
 * In a production pipeline these are populated by loaders reading the soul's
 * `journeys[]` declarations plus live metric snapshots.
 */
export interface JourneyScores {
  /**
   * Journey-scoped Sα₂ (Vibe Coherence) in [0, 1].
   * Derived from journey.designImperatives UNION variant's UNION soul's;
   * most-specific wins (journey > variant > soul).
   */
  sa2: number;
  /**
   * Journey-scoped Cκ (Capability Coverage) in [0, 1].
   * Boosted above the soul/variant baseline when `completion-rate < alertBelow`.
   */
  ck: number;
  /**
   * Whether journey accessibility requirements are elevated above soul floor.
   * When true, Eρ₅ Compliance Clearance is checked at journey-elevated WCAG
   * level rather than the soul-default. Categorical: `true` = elevation active.
   */
  er5Elevated: boolean;
}

/**
 * Per-Soul / per-org cross-journey aggregation config.
 * Default `min` per RFC-0018 §5.4 (matching RFC-0017 OQ-4 cross-variant pattern).
 */
export type JourneyAggregationRule = 'min' | 'max' | 'mean';

/**
 * Per-Soul journey configuration (subset of §10.1 journey-config.yaml schema).
 */
export interface JourneyConfig {
  /**
   * Cross-journey aggregation rule for multi-journey work items.
   * Default `min` per RFC-0018 §5.4. Per-Soul override via journey-config.yaml.
   */
  crossJourneyAggregation?: JourneyAggregationRule;
  /**
   * Soul-default WCAG level — used for Eρ₅ elevation comparison.
   * When absent, `'AA'` is assumed (WCAG 2.1 AA is the industry-standard floor).
   */
  soulWcagDefault?: WcagLevel;
}

// ── Work-item targeting ──────────────────────────────────────────────────

/**
 * Work-item targeting entry for journey-scope routing.
 * One entry per work item in the active backlog.
 */
export interface WorkItemJourneyTargeting {
  /** Canonical work item ID (case-insensitive match). */
  id: string;
  /**
   * Journey references declared on the work item.
   * URI shape: `<soul-id>/<journey-id>` OR `<soul-id>/<variant-id>/<journey-id>`
   * per RFC-0018 §6.1 Work Item schema.
   */
  targetedJourneys?: string[];
}

/**
 * All journey-scope context needed by the admission composite for RFC-0018 Phase 2.
 *
 * Callers build this once per pipeline tick and pass it to
 * `computeJourneyScopedScores` via `AdmissionCompositeOptions.journeyContext`.
 */
export interface JourneyContext {
  /**
   * Journey declarations keyed by soulId. Source of truth for which journey IDs
   * are valid per Soul + their scoring configuration.
   */
  journeysBySoul: Record<string, JourneyDeclaration[]>;
  /**
   * Pre-computed per-journey scores, keyed first by soulId then by journeyId.
   * Missing entries fall back to the work item's soul/variant Sα₂/Cκ/Eρ₅.
   */
  journeyScores: Record<string, Record<string, JourneyScores>>;
  /**
   * Work-item targeting entries — one per work item in the active backlog.
   * Missing entries (or empty `targetedJourneys`) → backward-compat soul/variant scope.
   */
  workItemTargeting?: WorkItemJourneyTargeting[];
  /**
   * Per-Soul journey configuration overrides.
   * Keyed by soulId. Absent → `{ crossJourneyAggregation: 'min' }` default.
   */
  configBySoul?: Record<string, JourneyConfig>;
}

// ── URI parsing ──────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

/**
 * One parsed targeted-journey reference. Internal use; surfaced via the router
 * for auditability.
 */
export interface ParsedJourneyRef {
  soulId: string;
  /** Present when the journey is variant-scoped (URI form: soul/variant/journey). */
  variantId?: string;
  journeyId: string;
  /** The original URI string (for round-trip + error reporting). */
  raw: string;
}

/**
 * Parse a targeted-journey reference.
 *
 * Accepts two URI forms per RFC-0018 §6.1:
 *
 *   1. `<soul-id>/<journey-id>` — soul-scoped journey
 *   2. `<soul-id>/<variant-id>/<journey-id>` — variant-scoped journey
 *
 * All slug segments must match `^[a-z][a-z0-9-]*$`.
 * Returns `undefined` for malformed input (silent skip; schema-side validator
 * is Phase 1's concern per RFC-0018 §6.1 pattern).
 */
export function parseTargetedJourneyRef(raw: string): ParsedJourneyRef | undefined {
  const parts = raw.split('/');
  if (parts.length === 2) {
    const [soulId, journeyId] = parts;
    if (SLUG_RE.test(soulId) && SLUG_RE.test(journeyId)) {
      return { soulId, journeyId, raw };
    }
  } else if (parts.length === 3) {
    const [soulId, variantId, journeyId] = parts;
    if (SLUG_RE.test(soulId) && SLUG_RE.test(variantId) && SLUG_RE.test(journeyId)) {
      return { soulId, variantId, journeyId, raw };
    }
  }
  return undefined;
}

// ── resolveTargetedJourneys ──────────────────────────────────────────────

/**
 * Resolve the set of targeted (soulId, [variantId,] journeyId) triples for a work item.
 *
 * Algorithm:
 * 1. Find the work item by case-insensitive ID match in `workItemTargeting`.
 * 2. Parse each entry of `targetedJourneys[]` via `parseTargetedJourneyRef`.
 * 3. Filter parsed refs against `journeysBySoul` — a (soulId, journeyId) pair
 *    only survives if the soul exists AND the journeyId is declared on it.
 * 4. Return the validated intersection (empty = backward-compat soul/variant scope).
 */
export function resolveTargetedJourneys(
  workItemId: string,
  journeyCtx: JourneyContext | undefined,
): ParsedJourneyRef[] {
  if (!journeyCtx || !journeyCtx.workItemTargeting || journeyCtx.workItemTargeting.length === 0) {
    return [];
  }
  const normalizedId = workItemId.toLowerCase();
  const entry = journeyCtx.workItemTargeting.find((e) => e.id.toLowerCase() === normalizedId);
  if (!entry || !entry.targetedJourneys || entry.targetedJourneys.length === 0) {
    return [];
  }
  const out: ParsedJourneyRef[] = [];
  for (const raw of entry.targetedJourneys) {
    const parsed = parseTargetedJourneyRef(raw);
    if (!parsed) continue;
    const journeys = journeyCtx.journeysBySoul[parsed.soulId];
    if (!journeys) continue;
    if (!journeys.some((j) => j.id === parsed.journeyId)) continue;
    out.push(parsed);
  }
  return out;
}

// ── Cross-journey aggregation ────────────────────────────────────────────

/**
 * Apply a per-Soul `crossJourneyAggregation` rule over per-journey scores.
 * Mirrors `applyCrossVariantRule` in `variant-admission.ts` but for journey scope.
 *
 * @param values   - Per-journey score samples (one per targeted journey).
 * @param rule     - The aggregation rule (defaults to `min` per RFC-0018 §5.4 + OQ-4).
 * @param fallback - Returned when `values` is empty.
 */
export function applyCrossJourneyRule(
  values: number[],
  rule: JourneyAggregationRule | undefined,
  fallback = 0.5,
): number {
  if (values.length === 0) return fallback;
  switch (rule ?? 'min') {
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'mean':
      return values.reduce((sum, v) => sum + v, 0) / values.length;
  }
}

// ── computeJourneyScopedScores (the router) ──────────────────────────────

/**
 * Result of journey-scope resolution. Composed with variant-scope and
 * tessellation results by the admission composite.
 *
 * Journey routing refines Sα₂, Cκ, and Eρ₅ when the work item declares
 * `targetedJourneys` (RFC-0018 §5.4). Sα₁ and Dπ_n remain at soul/variant
 * scope (journeys don't redefine audience or demand channels).
 */
export interface JourneyScopedResult {
  /** Resolved Sα₂ in [0, 1] (journey-scoped or fallback). */
  sa2: number;
  /** Resolved Cκ in [0, 1] (journey-scoped or fallback). */
  ck: number;
  /**
   * Whether Eρ₅ should be evaluated at journey-elevated WCAG level.
   * When `true`, the caller MUST apply Eρ₅ gating at the journey's WCAG
   * level rather than the soul-default. `false` = soul-default applies.
   */
  er5Elevated: boolean;
  /**
   * Routing path taken (matches RFC-0018 §5.4 case labels).
   *
   * - `'no-journey-routing'` — no context or no targeted journeys declared;
   *                             fallback Sα₂/Cκ/Eρ₅ preserved (backward-compat).
   * - `'single-journey'`     — exactly one targeted journey; per-journey scores used.
   * - `'multi-journey'`      — multiple targeted journeys; crossJourneyAggregation applied.
   */
  routingPath: 'no-journey-routing' | 'single-journey' | 'multi-journey';
  /** Targeted journey references that contributed to the aggregation. */
  targetedJourneys: ParsedJourneyRef[];
  /**
   * The aggregation rule used when `routingPath === 'multi-journey'`. Undefined
   * for `single-journey` and `no-journey-routing` paths. Exposed for audit.
   */
  aggregationRule?: JourneyAggregationRule;
}

/**
 * Compute the journey-scope-refined Sα₂ + Cκ + Eρ₅ for a work item.
 *
 * This runs AFTER variant-scope resolution: the caller has already routed the
 * work item to its target Soul(s)/Variant(s) and obtained the soul/variant
 * Sα₂ (the `fallbackSa2` argument) and Cκ (the `fallbackCk` argument).
 * Journey routing refines those values when the work item declares
 * `targetedJourneys` of one of the affected Souls (RFC-0018 §5.4).
 *
 * **Sα₂ Vibe Coherence** — journey's `designImperatives` UNION variant's UNION
 * soul's; conflict resolution: most-specific wins (journey > variant > soul).
 * The pre-computed `JourneyScores.sa2` in the context encodes this resolution.
 *
 * **Cκ Capability Coverage** — boosted when `completion-rate < alertBelow`.
 * The pre-computed `JourneyScores.ck` encodes the boost; callers supply live
 * metric snapshots to the loader that builds `journeyScores`.
 *
 * **Eρ₅ Compliance Clearance** — elevated when journey WCAG > soul-default.
 * The pre-computed `JourneyScores.er5Elevated` flag captures this; the caller
 * applies Eρ₅ gating at the journey's elevated level when `er5Elevated = true`.
 *
 * **Cross-journey aggregation** (work touches multiple journeys) — same `min`
 * as RFC-0018 §5.4 / RFC-0009 §7.2 / RFC-0017 OQ-4 by default. Per-Soul
 * override via `journeyConfig.crossJourneyAggregation`.
 *
 * @param workItemId   - The canonical work item ID.
 * @param fallbackSa2  - Soul/variant Sα₂ to use when no journey routing applies.
 * @param fallbackCk   - Soul/variant Cκ to use when no journey routing applies.
 * @param fallbackEr5Elevated - Soul/variant Eρ₅ elevation flag (usually false).
 * @param journeyCtx   - Journey-scope context; undefined → backward-compat passthrough.
 */
export function computeJourneyScopedScores(
  workItemId: string,
  fallbackSa2: number,
  fallbackCk: number,
  fallbackEr5Elevated: boolean,
  journeyCtx: JourneyContext | undefined,
): JourneyScopedResult {
  const targetedJourneys = resolveTargetedJourneys(workItemId, journeyCtx);

  // ── Backward-compat: no targeted journeys → soul/variant scope passthrough ──
  if (targetedJourneys.length === 0 || !journeyCtx) {
    return {
      sa2: fallbackSa2,
      ck: fallbackCk,
      er5Elevated: fallbackEr5Elevated,
      routingPath: 'no-journey-routing',
      targetedJourneys: [],
    };
  }

  // ── Single-journey fast path ──
  if (targetedJourneys.length === 1) {
    const ref = targetedJourneys[0];
    const scores = journeyCtx.journeyScores[ref.soulId]?.[ref.journeyId];
    return {
      sa2: scores?.sa2 ?? fallbackSa2,
      ck: scores?.ck ?? fallbackCk,
      er5Elevated: scores?.er5Elevated ?? fallbackEr5Elevated,
      routingPath: 'single-journey',
      targetedJourneys,
    };
  }

  // ── Multi-journey: aggregate per-Soul, then aggregate cross-Soul ──
  // Per-Soul aggregation uses the Soul's `crossJourneyAggregation` config
  // (default `min`). When journeys span multiple souls (rare), the cross-Soul
  // layer also uses `min` as the safest default (RFC-0009 §7.2).
  const bySoul = new Map<string, ParsedJourneyRef[]>();
  for (const ref of targetedJourneys) {
    const bucket = bySoul.get(ref.soulId);
    if (bucket) bucket.push(ref);
    else bySoul.set(ref.soulId, [ref]);
  }

  const perSoulSa2: number[] = [];
  const perSoulCk: number[] = [];
  const perSoulEr5Elevated: boolean[] = [];
  let firstAggregationRule: JourneyAggregationRule | undefined;

  for (const [soulId, refs] of bySoul) {
    const cfg = journeyCtx.configBySoul?.[soulId];
    const rule: JourneyAggregationRule = cfg?.crossJourneyAggregation ?? 'min';
    if (firstAggregationRule === undefined) firstAggregationRule = rule;

    const sa2Samples: number[] = [];
    const ckSamples: number[] = [];
    const er5Samples: boolean[] = [];

    for (const ref of refs) {
      const scores = journeyCtx.journeyScores[soulId]?.[ref.journeyId];
      sa2Samples.push(scores?.sa2 ?? fallbackSa2);
      ckSamples.push(scores?.ck ?? fallbackCk);
      er5Samples.push(scores?.er5Elevated ?? fallbackEr5Elevated);
    }

    perSoulSa2.push(applyCrossJourneyRule(sa2Samples, rule, fallbackSa2));
    perSoulCk.push(applyCrossJourneyRule(ckSamples, rule, fallbackCk));
    // Eρ₅ elevation: `true` wins if ANY journey requires elevation
    // (conservative — if at least one journey has elevated WCAG, the
    // work item is evaluated at that stricter level).
    perSoulEr5Elevated.push(er5Samples.some(Boolean));
  }

  // Cross-Soul layering: `min` between Souls for numeric scores (RFC-0009 §7.2).
  // Eρ₅ elevation: `true` if any Soul has elevated WCAG (conservative/safe).
  const sa2 = perSoulSa2.length === 1 ? perSoulSa2[0] : Math.min(...perSoulSa2);
  const ck = perSoulCk.length === 1 ? perSoulCk[0] : Math.min(...perSoulCk);
  const er5Elevated = perSoulEr5Elevated.some(Boolean);

  return {
    sa2,
    ck,
    er5Elevated,
    routingPath: 'multi-journey',
    targetedJourneys,
    aggregationRule: firstAggregationRule ?? 'min',
  };
}
