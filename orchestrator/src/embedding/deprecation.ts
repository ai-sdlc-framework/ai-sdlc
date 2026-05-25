/**
 * Deprecation lifecycle per RFC-0019 §9.1 + OQ-4 re-walkthrough.
 *
 * Three-layer grace-period precedence (highest → lowest):
 *   1. per-org `gracePeriodDays` from `.ai-sdlc/embedding-config.yaml`
 *   2. adapter-declared `defaultGracePeriodDays` (capability matrix)
 *   3. framework default — 90 days
 *
 * Catalog dedup via per-Decision-key counter prevents Decision flood under
 * orchestrator-driven loads: emit `Decision: embedding-provider-deprecated`
 * at MILESTONES (89/60/30/7/1 days before deprecatedAt), NOT per-load. The
 * dedup key is `embedding-provider-deprecated:<adapter-name>:<deprecatedAt>`.
 *
 * Lifecycle phases:
 *   - Pre-warning   : today < (deprecatedAt - gracePeriod) → silent
 *   - Warning       : today ∈ [deprecatedAt - gracePeriod, deprecatedAt) → milestone events
 *   - Deprecated    : today ∈ [deprecatedAt, removedAt) → continued warnings; HIGH in strict mode
 *   - Removed       : today ≥ removedAt → emit `Decision: embedding-provider-removed`
 *                     + auto-action: emit cli-embedding-bump migration task.
 *                     Pipeline NEVER halts — downstream consumers degrade.
 *
 * @module embedding/deprecation
 */

/**
 * Framework default grace-period length per OQ-4 re-walkthrough.
 * Conservative within OpenAI's typical 12-15 month deprecation window.
 */
export const FRAMEWORK_DEFAULT_GRACE_PERIOD_DAYS = 90;

/**
 * Days-before-deprecatedAt at which a catalog Decision is emitted.
 * Dedup counter ensures one event per milestone per (adapter, deprecatedAt) tuple.
 *
 * Sorted DESCENDING — when computing "next-due milestone" we walk from
 * largest to smallest and pick the first one we have crossed.
 */
export const DEPRECATION_MILESTONE_DAYS: ReadonlyArray<number> = [89, 60, 30, 7, 1];

/**
 * Inputs to the deprecation lifecycle evaluator.
 * `today` defaults to the current date; callers pass an explicit Date in tests.
 */
export interface DeprecationLifecycleInput {
  /** Canonical adapter name (e.g., 'openai-text-embedding-ada-002'). */
  adapterName: string;
  /** ISO date when the deprecation warning period starts (adapter.deprecatedAt). */
  deprecatedAt?: string;
  /** ISO date when the adapter is removed (adapter.removedAt). */
  removedAt?: string;
  /** Canonical replacement alias for migration messaging. */
  replacementAlias?: string;
  /** Adapter-declared default grace period override. */
  adapterDefaultGracePeriodDays?: number;
  /** Per-org override from embedding-config.yaml. */
  orgGracePeriodDays?: number;
  /** Whether the operator runs in strict mode (escalate severity at deprecatedAt). */
  strictModeAtDeprecatedAt?: boolean;
  /** Override "today" for deterministic tests. */
  today?: Date;
}

/**
 * Lifecycle phase the adapter is currently in.
 */
export type DeprecationPhase = 'pre-warning' | 'warning' | 'deprecated' | 'removed' | 'inactive';

/**
 * One catalog Decision event the caller should append.
 */
export interface DeprecationDecisionEvent {
  /** RFC-0035 catalog Decision type. */
  decisionType: 'embedding-provider-deprecated' | 'embedding-provider-removed';
  /** Dedup key — caller MUST refuse duplicate emissions for the same key. */
  dedupKey: string;
  /** Catalog severity. */
  severity: 'info' | 'high';
  /** Human-readable summary used as the Decision summary. */
  summary: string;
  /** Milestone reached, in days-before-deprecatedAt. Null for `removed` events. */
  milestoneDaysBefore: number | null;
  /**
   * Auto-action the orchestrator MUST perform when this event lands.
   * `null` for milestone events that don't auto-trigger anything.
   */
  autoAction: 'emit-migration-task' | null;
}

/**
 * Result of evaluating the deprecation lifecycle for one adapter at one point
 * in time.
 */
export interface DeprecationLifecycleResult {
  /** Current phase. */
  phase: DeprecationPhase;
  /** Effective grace period used (after three-layer precedence). */
  effectiveGracePeriodDays: number;
  /** Days from today to deprecatedAt (negative if past). Null when undeclared. */
  daysToDeprecatedAt: number | null;
  /** Days from today to removedAt (negative if past). Null when undeclared. */
  daysToRemovedAt: number | null;
  /**
   * Decision events the caller should emit. May be empty (phase == pre-warning
   * OR no milestone was crossed in the current load).
   *
   * The caller is responsible for catalog dedup — DO NOT emit when the dedup
   * key has already been seen. See {@link DeprecationDecisionEvent.dedupKey}.
   */
  decisionEvents: DeprecationDecisionEvent[];
}

/**
 * Resolve the effective grace period using the three-layer precedence chain
 * per OQ-4 re-walkthrough.
 */
export function resolveGracePeriodDays(
  orgOverride: number | undefined,
  adapterDefault: number | undefined,
): number {
  if (typeof orgOverride === 'number' && Number.isFinite(orgOverride) && orgOverride > 0) {
    return orgOverride;
  }
  if (typeof adapterDefault === 'number' && Number.isFinite(adapterDefault) && adapterDefault > 0) {
    return adapterDefault;
  }
  return FRAMEWORK_DEFAULT_GRACE_PERIOD_DAYS;
}

/** Compute calendar-day difference (positive = future, negative = past). */
function daysBetween(from: Date, to: Date): number {
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  // Normalize to UTC midnight so DST transitions don't bias the count.
  const fromUtc = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const toUtc = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((toUtc - fromUtc) / MS_PER_DAY);
}

/**
 * Find the most-recently-crossed milestone at the current moment — i.e., the
 * SMALLEST milestone the caller is at-or-under. Returns `null` when no
 * milestone is due (today is BEFORE the largest milestone OR adapter has no
 * deprecatedAt).
 *
 * "Crossed" = `daysToDeprecatedAt <= milestone`. We want the smallest such
 * milestone so each emission represents a NEW threshold crossed:
 *
 *   90 days out → no milestone due
 *   89 days out → milestone 89 (largest threshold first crossed)
 *   75 days out → milestone 89 (still inside 89 window, 60 not yet crossed)
 *   60 days out → milestone 60 (newly crossed)
 *   50 days out → milestone 60 (still inside 60, 30 not yet crossed)
 *   30 days out → milestone 30
 *   ...
 *
 * The dedup counter then collapses repeated emissions at the same milestone
 * to exactly one event per (adapter, deprecatedAt, milestone) tuple.
 *
 * @param daysToDeprecatedAt - Result from `daysBetween(today, deprecatedAt)`.
 *   Positive when deprecatedAt is in the future, negative when past.
 */
export function nextDueMilestone(daysToDeprecatedAt: number): number | null {
  // After deprecatedAt: no milestone is "due" (we emit the deprecated phase
  // event instead).
  if (daysToDeprecatedAt < 0) return null;
  // Sorted ASCENDING for this lookup: pick the SMALLEST milestone we are
  // at-or-under so each crossing surfaces as a distinct emission.
  const ascending = [...DEPRECATION_MILESTONE_DAYS].sort((a, b) => a - b);
  for (const milestone of ascending) {
    if (daysToDeprecatedAt <= milestone) return milestone;
  }
  return null;
}

/**
 * Build the catalog dedup key for a deprecation event at a given milestone.
 * Same key across pipeline loads → caller refuses to emit a second time.
 */
export function buildDedupKey(
  decisionType: DeprecationDecisionEvent['decisionType'],
  adapterName: string,
  deprecatedAt: string | undefined,
  milestoneDaysBefore: number | null,
): string {
  const base = `${decisionType}:${adapterName}:${deprecatedAt ?? 'undeclared'}`;
  return milestoneDaysBefore === null ? base : `${base}:m${milestoneDaysBefore}`;
}

/**
 * Evaluate the deprecation lifecycle for one adapter.
 *
 * Returns the phase, resolved grace period, and any catalog Decision events
 * the caller should emit. Pipeline-load NEVER halts on the result; downstream
 * consumers degrade gracefully per the RFC-0035 G0 non-blocking contract.
 *
 * Dedup contract: the returned `decisionEvents` always carry the dedup key.
 * The caller MUST consult its dedup store before appending — re-emitting the
 * same `(adapter, deprecatedAt, milestone)` triple is a bug.
 */
export function evaluateDeprecationLifecycle(
  input: DeprecationLifecycleInput,
): DeprecationLifecycleResult {
  const today = input.today ?? new Date();
  const effectiveGracePeriodDays = resolveGracePeriodDays(
    input.orgGracePeriodDays,
    input.adapterDefaultGracePeriodDays,
  );

  // Inactive — no lifecycle declared.
  if (!input.deprecatedAt && !input.removedAt) {
    return {
      phase: 'inactive',
      effectiveGracePeriodDays,
      daysToDeprecatedAt: null,
      daysToRemovedAt: null,
      decisionEvents: [],
    };
  }

  const daysToDeprecatedAt = input.deprecatedAt
    ? daysBetween(today, new Date(input.deprecatedAt))
    : null;
  const daysToRemovedAt = input.removedAt ? daysBetween(today, new Date(input.removedAt)) : null;

  // Removed — strongest signal. Always emit migration task.
  if (daysToRemovedAt !== null && daysToRemovedAt <= 0) {
    const dedupKey = buildDedupKey(
      'embedding-provider-removed',
      input.adapterName,
      input.deprecatedAt,
      null,
    );
    return {
      phase: 'removed',
      effectiveGracePeriodDays,
      daysToDeprecatedAt,
      daysToRemovedAt,
      decisionEvents: [
        {
          decisionType: 'embedding-provider-removed',
          dedupKey,
          severity: 'high',
          summary:
            `Embedding adapter '${input.adapterName}' was removed on ${input.removedAt}. ` +
            `Downstream consumers degrade gracefully (no pipeline halt). ` +
            (input.replacementAlias
              ? `Migrate via: cli-embedding-bump --to ${input.replacementAlias}`
              : 'No replacement alias declared.'),
          milestoneDaysBefore: null,
          autoAction: 'emit-migration-task',
        },
      ],
    };
  }

  // Deprecated — past deprecatedAt but before removedAt.
  if (daysToDeprecatedAt !== null && daysToDeprecatedAt <= 0) {
    const severity = input.strictModeAtDeprecatedAt ? 'high' : 'info';
    const dedupKey = buildDedupKey(
      'embedding-provider-deprecated',
      input.adapterName,
      input.deprecatedAt,
      // Post-deprecatedAt: dedup on "phase-deprecated" rather than a milestone.
      // Use a sentinel value (0) so future loads with the same key stay deduped.
      0,
    );
    return {
      phase: 'deprecated',
      effectiveGracePeriodDays,
      daysToDeprecatedAt,
      daysToRemovedAt,
      decisionEvents: [
        {
          decisionType: 'embedding-provider-deprecated',
          dedupKey,
          severity,
          summary:
            `Embedding adapter '${input.adapterName}' was deprecated on ${input.deprecatedAt}. ` +
            (input.replacementAlias
              ? `Run: cli-embedding-bump --to ${input.replacementAlias}`
              : 'No replacement alias declared.'),
          milestoneDaysBefore: 0,
          autoAction: null,
        },
      ],
    };
  }

  // Warning period — today ∈ [deprecatedAt - gracePeriod, deprecatedAt).
  if (
    daysToDeprecatedAt !== null &&
    daysToDeprecatedAt > 0 &&
    daysToDeprecatedAt <= effectiveGracePeriodDays
  ) {
    const milestone = nextDueMilestone(daysToDeprecatedAt);
    if (milestone === null) {
      // We are inside the warning window but BEFORE the largest milestone (89d).
      // No event to emit yet.
      return {
        phase: 'warning',
        effectiveGracePeriodDays,
        daysToDeprecatedAt,
        daysToRemovedAt,
        decisionEvents: [],
      };
    }
    const dedupKey = buildDedupKey(
      'embedding-provider-deprecated',
      input.adapterName,
      input.deprecatedAt,
      milestone,
    );
    return {
      phase: 'warning',
      effectiveGracePeriodDays,
      daysToDeprecatedAt,
      daysToRemovedAt,
      decisionEvents: [
        {
          decisionType: 'embedding-provider-deprecated',
          dedupKey,
          severity: 'info',
          summary:
            `Embedding adapter '${input.adapterName}' will be deprecated on ${input.deprecatedAt} ` +
            `(${daysToDeprecatedAt} days, milestone ${milestone}d). ` +
            (input.replacementAlias
              ? `Migrate via: cli-embedding-bump --to ${input.replacementAlias}`
              : 'No replacement alias declared.'),
          milestoneDaysBefore: milestone,
          autoAction: null,
        },
      ],
    };
  }

  // Pre-warning — today is more than `gracePeriodDays` before deprecatedAt.
  return {
    phase: 'pre-warning',
    effectiveGracePeriodDays,
    daysToDeprecatedAt,
    daysToRemovedAt,
    decisionEvents: [],
  };
}
