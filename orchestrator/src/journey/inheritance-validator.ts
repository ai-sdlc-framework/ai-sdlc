/**
 * RFC-0018 Phase 1 — Journey Inheritance Validator.
 *
 * Implements RFC-0018 §5.3 bounded-inheritance enforcement for journey
 * declarations on Soul DIDs and Variants. When a violation is detected the
 * validator emits a `JourneyInheritanceViolation` event (RFC-0008 §C5).
 *
 * Covers the following AC items (AISDLC-465):
 *   AC #5: JourneyInheritanceViolation event emitted for all 5 violation classes.
 *   AC #7: Journey count thresholds emit Decisions (journey-count-soft-warning at >=10;
 *           journey-count-hard-limit-exceeded at >=50).
 *   AC #8: State count thresholds emit Decisions (journey-state-count-soft-warning at >=12
 *           with v1-workaround message; journey-state-count-hard-limit-exceeded at >=100).
 *   AC #9: Nested journeys[] rejected at schema validation (schema-enforced flat, OQ-3).
 *  AC #10: Decision: journey-sub-flow-activation-request Stage A counter wired.
 *
 * ### Bounded inheritance (§5.3)
 *
 * Journeys MUST NOT attempt to override the following fields inherited from
 * the parent Soul DID (or Variant when scope=variant):
 *
 *   1. `complianceRegimes`    — per-soul (locked at soul/variant level)
 *   2. `targetAudience`       — inherits from soul or variant
 *   3. `substrateInvariants`  — locked at soul level
 *   4. `complianceFloor`      — when scope=variant, MUST be 'inherit' (never a custom value)
 *   5. `wcagLevel` lowering   — journeys MAY raise WCAG above parent but NEVER lower it
 *
 * ### Count + state limits (OQ-1, OQ-2)
 *
 * Per-org configurable via `.ai-sdlc/journey-config.yaml`:
 *   journey.limits.softWarnAt (default 10) / journey.limits.hardLimit (default 50)
 *   journey.stateLimits.softWarnAt (default 12) / journey.stateLimits.hardLimit (default 100)
 *
 * ### Nested-journey rejection (OQ-3)
 *
 * Schema-enforced flat: a journey declaration MUST NOT contain a `journeys[]`
 * field. Emits `NestedJourneyRejected` (blocking).
 *
 * ### Sub-flow activation counter (OQ-3)
 *
 * Tracks distinct adopter requests for journey-sub-flow activation. When a
 * journey declaration contains a nested `journeys[]` field, the validator:
 *   1. Emits `NestedJourneyRejected` (blocking).
 *   2. Records the request in the sub-flow activation counter.
 *   3. When distinctAdopterCount >= threshold (default 2), marks
 *      `promotedToOperatorReview: true` in the counter result, signalling
 *      that a follow-on RFC discussion should be surfaced.
 *
 * @see spec/rfcs/RFC-0018-in-soul-journey-pattern.md §5.3 + §10.1
 * @see orchestrator/src/variant/inheritance-validator.ts — parallel RFC-0017 validator
 */

// ── Inherited (locked) field names per RFC-0018 §5.3 ──────────────────────────

/**
 * Field names that are INHERITED from the parent Soul DID and cannot be
 * overridden by any journey declaration. Attempting to declare these on a
 * journey triggers a `JourneyInheritanceViolation`.
 *
 * Note: `complianceFloor` is validated separately (it must be 'inherit' when
 * scope=variant, not merely absent) — see `validateComplianceFloor`.
 */
export const JOURNEY_INHERITED_LOCKED_FIELDS = [
  'complianceRegimes',
  'targetAudience',
  'substrateInvariants',
] as const;

export type JourneyInheritedLockedField = (typeof JOURNEY_INHERITED_LOCKED_FIELDS)[number];

// ── WCAG level ordering ────────────────────────────────────────────────────────

/**
 * Numeric ordering for WCAG levels. Higher = stricter.
 * Used to detect lowering of WCAG level below parent.
 */
export const WCAG_LEVEL_ORDER: Record<string, number> = {
  A: 1,
  AA: 2,
  AAA: 3,
};

// ── Event types ────────────────────────────────────────────────────────────────

/**
 * Discriminated event kind for journey-level events emitted to events.jsonl.
 */
export type JourneyEventKind =
  | 'JourneyInheritanceViolation'
  | 'JourneyCountSoftWarning'
  | 'JourneyCountHardLimitExceeded'
  | 'JourneyStateCountSoftWarning'
  | 'JourneyStateCountHardLimitExceeded'
  | 'NestedJourneyRejected';

/**
 * The 5 violation classes per RFC-0018 §5.3 bounded inheritance.
 *
 * Each violation class corresponds to a field (or semantic constraint)
 * that a journey may NOT override from its parent Soul DID or Variant.
 */
export type JourneyViolationClass =
  | 'complianceRegimes'
  | 'targetAudience'
  | 'substrateInvariants'
  | 'complianceFloor'
  | 'wcagLevel-lowered-below-parent';

/**
 * Emitted when a journey attempts to override an inherited locked field per
 * RFC-0018 §5.3. This is an Engineering vertex error (RFC-0008 §C5).
 *
 * The result is `blocking: true` — the declaring Soul DID is invalid until
 * the offending override is removed.
 */
export interface JourneyInheritanceViolation {
  readonly kind: 'JourneyInheritanceViolation';
  /** Identifier of the Soul DID that contains the offending journey. */
  readonly soulId: string;
  /** The journey's `id` field value. */
  readonly journeyId: string;
  /** The violation class (which inheritance constraint was broken). */
  readonly violationClass: JourneyViolationClass;
  /** Human-readable description of the violation. */
  readonly message: string;
  /** Always true — inheritance violations are blocking errors. */
  readonly blocking: true;
  readonly timestamp: string;
}

/**
 * Non-blocking warning emitted when a Soul DID's journey count reaches the
 * soft-warn threshold (default 10 per OQ-1). Routes through Decision Catalog
 * as `Decision: journey-count-soft-warning` for operator batch review.
 */
export interface JourneyCountSoftWarning {
  readonly kind: 'JourneyCountSoftWarning';
  readonly soulId: string;
  readonly journeyCount: number;
  readonly threshold: number;
  readonly message: string;
  readonly blocking: false;
  readonly timestamp: string;
}

/**
 * Hard-blocking rejection emitted when a Soul DID's journey count reaches the
 * hard limit (default 50 per OQ-1). The Soul DID declaration is rejected.
 * Routes through Decision Catalog as `Decision: journey-count-hard-limit-exceeded`
 * plus a clarification task.
 */
export interface JourneyCountHardLimitExceeded {
  readonly kind: 'JourneyCountHardLimitExceeded';
  readonly soulId: string;
  readonly journeyCount: number;
  readonly limit: number;
  readonly message: string;
  readonly blocking: true;
  readonly timestamp: string;
}

/**
 * Non-blocking warning emitted when a journey's state count reaches the
 * soft-warn threshold (default 12 per OQ-2). Includes concrete v1 workaround
 * message pointing at the split-journeys pattern.
 */
export interface JourneyStateCountSoftWarning {
  readonly kind: 'JourneyStateCountSoftWarning';
  readonly soulId: string;
  readonly journeyId: string;
  readonly stateCount: number;
  readonly threshold: number;
  readonly message: string;
  readonly v1WorkaroundMessage: string;
  readonly blocking: false;
  readonly timestamp: string;
}

/**
 * Hard-blocking rejection emitted when a journey's state count reaches the
 * hard limit (default 100 per OQ-2). This is a sanity guard (typo /
 * runaway-loop), NOT an architectural constraint.
 */
export interface JourneyStateCountHardLimitExceeded {
  readonly kind: 'JourneyStateCountHardLimitExceeded';
  readonly soulId: string;
  readonly journeyId: string;
  readonly stateCount: number;
  readonly limit: number;
  readonly message: string;
  readonly blocking: true;
  readonly timestamp: string;
}

/**
 * Emitted when a nested `journeys[]` field is detected inside a journey
 * declaration. Schema-enforced flat per RFC-0018 OQ-3. Blocking.
 */
export interface NestedJourneyRejected {
  readonly kind: 'NestedJourneyRejected';
  readonly soulId: string;
  readonly journeyId: string;
  readonly message: string;
  readonly blocking: true;
  readonly timestamp: string;
}

export type JourneyEvent =
  | JourneyInheritanceViolation
  | JourneyCountSoftWarning
  | JourneyCountHardLimitExceeded
  | JourneyStateCountSoftWarning
  | JourneyStateCountHardLimitExceeded
  | NestedJourneyRejected;

// ── Sub-flow activation counter (OQ-3) ────────────────────────────────────────

/**
 * Result of the sub-flow activation counter check (OQ-3).
 *
 * Tracks distinct adopter requests for journey-sub-flow activation.
 * When `distinctAdopterCount >= threshold`, `promotedToOperatorReview` is
 * set to `true` — a signal to surface the topic for follow-on RFC discussion.
 */
export interface SubFlowActivationCounterResult {
  readonly decision: 'journey-sub-flow-activation-request';
  readonly distinctAdopterCount: number;
  readonly threshold: number;
  readonly promotedToOperatorReview: boolean;
  readonly adopters: readonly string[];
  readonly recommendation: string;
}

// ── Input types ────────────────────────────────────────────────────────────────

/**
 * Minimal representation of one state declaration as loaded from a journey.
 */
export interface JourneyStateInput {
  /** State identifier (kebab-case). */
  id: string;
  /** Whether this state is a terminal state. */
  terminal?: boolean;
  /** Whether this terminal state is a success state. */
  successState?: boolean;
  [key: string]: unknown;
}

/**
 * Minimal accessibility block as loaded from a journey.
 */
export interface JourneyAccessibilityInput {
  /** WCAG level declared on this journey. */
  wcagLevel?: string;
  [key: string]: unknown;
}

/**
 * Minimal representation of one journey declaration as loaded from a Soul DID
 * or Variant. Mirrors the JSON Schema shape at
 * `spec/schemas/journey.v1.schema.json`.
 */
export interface JourneyDeclarationInput {
  /** Kebab-case journey id. */
  id: string;
  /** Scope — 'soul' or 'variant:<id>'. */
  scope?: string;
  /** State declarations. */
  states?: JourneyStateInput[];
  /** Accessibility block (for WCAG-level inheritance check). */
  accessibility?: JourneyAccessibilityInput;
  /**
   * Any additional fields present in the raw declaration — used to detect
   * attempts to override locked inherited fields and nested journeys.
   */
  [key: string]: unknown;
}

/**
 * Per-org journey count configuration. Loaded from
 * `.ai-sdlc/journey-config.yaml` (`journey.limits`) with the defaults below.
 */
export interface JourneyLimitsConfig {
  /** Non-blocking soft warn threshold for journey count. Default: 10. */
  softWarnAt?: number;
  /** Hard-blocking rejection limit for journey count. Default: 50. */
  hardLimit?: number;
}

/**
 * Per-org journey state count configuration. Loaded from
 * `.ai-sdlc/journey-config.yaml` (`journey.stateLimits`) with the defaults below.
 */
export interface JourneyStateLimitsConfig {
  /** Non-blocking soft warn threshold for state count per journey. Default: 12. */
  softWarnAt?: number;
  /** Hard-blocking rejection limit for state count per journey. Default: 100. */
  hardLimit?: number;
  /** Optional operator-actionable message shown with soft-warn Decision. */
  softWarnMessage?: string;
}

/**
 * Per-org sub-flow activation counter configuration.
 * Loaded from `.ai-sdlc/journey-config.yaml` (`journey.subJourneys`).
 */
export interface SubFlowActivationConfig {
  /** Auto-promote threshold. Default: 2 distinct adopter requests. */
  distinctAdopterRequestsThreshold?: number;
}

/**
 * Options for `validateJourneyDeclarations`.
 */
export interface ValidateJourneyDeclarationsOptions {
  /** Identifier of the Soul DID being validated (for event attribution). */
  soulId: string;
  /** Raw journey declarations from the Soul DID's or Variant's `spec.journeys[]`. */
  journeys: JourneyDeclarationInput[];
  /** Per-org or per-Soul limit overrides for journey count. */
  limits?: JourneyLimitsConfig;
  /** Per-org or per-Soul limit overrides for state count per journey. */
  stateLimits?: JourneyStateLimitsConfig;
  /**
   * Parent WCAG level. When set, journeys with wcagLevel BELOW this are in violation.
   * Journeys may RAISE the WCAG level above parent but NEVER LOWER it (§5.3).
   */
  parentWcagLevel?: string;
  /** ISO 8601 timestamp to stamp on emitted events. Defaults to now. */
  now?: string;
}

// ── Default constants ─────────────────────────────────────────────────────────

/** OQ-1 default: soft warn at 10 journeys (Miller 7±2 + industry advisory). */
export const DEFAULT_JOURNEY_SOFT_WARN_AT = 10;
/** OQ-1 default: hard limit at 50 journeys (Salesforce-style enterprise ceiling). */
export const DEFAULT_JOURNEY_HARD_LIMIT = 50;

/** OQ-2 default: soft warn at 12 states (Miller 7±2 + XState advisory + IEEE readability). */
export const DEFAULT_STATE_SOFT_WARN_AT = 12;
/**
 * OQ-2 default: hard limit at 100 states (sanity guard, NOT architectural constraint).
 * Regulatory-submission journeys with 25-40 states are legitimate.
 */
export const DEFAULT_STATE_HARD_LIMIT = 100;

/**
 * OQ-2 default v1 workaround message: operator-actionable guidance when
 * a journey's state count reaches the soft-warn threshold.
 */
export const DEFAULT_STATE_SOFT_WARN_MESSAGE =
  'Consider splitting into multiple top-level journeys with handoff terminal states ' +
  '(v1 workaround) OR await OQ-3 sub-journey activation (v2)';

/** OQ-3 default: auto-promote sub-flow activation at 2 distinct adopter requests. */
export const DEFAULT_SUB_FLOW_ACTIVATION_THRESHOLD = 2;

// ── Validator ─────────────────────────────────────────────────────────────────

/**
 * Validate a Soul DID's (or Variant's) `journeys[]` declarations against
 * RFC-0018 §5.3 rules.
 *
 * Returns all emitted events. Callers check `event.blocking` to determine
 * whether the Soul DID should be rejected. Caller's responsibility to write
 * events to events.jsonl via the artifact layer.
 *
 * Validation rules (in order):
 *
 *   1. **Hard-limit check (OQ-1)** — if `journeys.length >= hardLimit`, emit
 *      `JourneyCountHardLimitExceeded` (blocking). Continue to check individual
 *      journeys for completeness of the error report.
 *
 *   2. **Soft-warn check (OQ-1)** — if `journeys.length >= softWarnAt` AND
 *      below hard limit, emit `JourneyCountSoftWarning` (non-blocking).
 *
 *   3. **Per-journey checks** — for each journey:
 *      a. Nested-journey rejection (OQ-3) — if journey has `journeys` key,
 *         emit `NestedJourneyRejected` (blocking).
 *      b. Inheritance violation check (§5.3) — for each locked field
 *         (`complianceRegimes`, `targetAudience`, `substrateInvariants`), if
 *         present on the journey emit `JourneyInheritanceViolation` (blocking).
 *      c. `complianceFloor` check — if scope=variant and complianceFloor is
 *         present but not 'inherit', emit `JourneyInheritanceViolation` (blocking).
 *      d. WCAG-level lowering check — if parentWcagLevel provided and journey's
 *         wcagLevel is LOWER than parent, emit `JourneyInheritanceViolation`
 *         (blocking).
 *      e. State count checks (OQ-2) — per-journey state count against
 *         stateLimits.hardLimit / stateLimits.softWarnAt.
 */
export function validateJourneyDeclarations(
  options: ValidateJourneyDeclarationsOptions,
): JourneyEvent[] {
  const { soulId, journeys, limits, stateLimits, parentWcagLevel, now } = options;
  const timestamp = now ?? new Date().toISOString();

  const softWarnAt = limits?.softWarnAt ?? DEFAULT_JOURNEY_SOFT_WARN_AT;
  const hardLimit = limits?.hardLimit ?? DEFAULT_JOURNEY_HARD_LIMIT;
  const stateSoftWarnAt = stateLimits?.softWarnAt ?? DEFAULT_STATE_SOFT_WARN_AT;
  const stateHardLimit = stateLimits?.hardLimit ?? DEFAULT_STATE_HARD_LIMIT;
  const stateWarnMessage = stateLimits?.softWarnMessage ?? DEFAULT_STATE_SOFT_WARN_MESSAGE;

  const events: JourneyEvent[] = [];
  const count = journeys.length;

  // Rule 1 — Journey count hard limit (OQ-1)
  if (count >= hardLimit) {
    events.push({
      kind: 'JourneyCountHardLimitExceeded',
      soulId,
      journeyCount: count,
      limit: hardLimit,
      message:
        `Soul '${soulId}' declares ${count} journey(s), reaching or exceeding the hard limit of ` +
        `${hardLimit}. Declaration rejected. Consider re-architecting as multiple top-level ` +
        `journeys with handoff terminal states or splitting across soul variants ` +
        `(RFC-0018 §5.5 boundary guidance). Decision: journey-count-hard-limit-exceeded.`,
      blocking: true,
      timestamp,
    });
  } else if (count >= softWarnAt) {
    // Rule 2 — Journey count soft warn (OQ-1, non-blocking)
    events.push({
      kind: 'JourneyCountSoftWarning',
      soulId,
      journeyCount: count,
      threshold: softWarnAt,
      message:
        `Soul '${soulId}' declares ${count} journey(s), at or above the soft-warn threshold of ` +
        `${softWarnAt}. Non-blocking review recommended. ` +
        `Decision: journey-count-soft-warning.`,
      blocking: false,
      timestamp,
    });
  }

  // Rule 3 — Per-journey checks
  for (const journey of journeys) {
    const journeyId = String(journey.id ?? '<unknown>');

    // Rule 3a — Nested journeys rejection (OQ-3)
    if (Object.prototype.hasOwnProperty.call(journey, 'journeys')) {
      events.push({
        kind: 'NestedJourneyRejected',
        soulId,
        journeyId,
        message:
          `Journey '${journeyId}' on soul '${soulId}' declares a nested 'journeys[]' field. ` +
          `RFC-0018 OQ-3 resolution mandates schema-enforced flat: journeys cannot contain ` +
          `sub-journeys in v1. Remove the nested 'journeys' field. ` +
          `v1 workaround: model sub-flows as multiple top-level journeys with handoff ` +
          `terminal states using shared userId/sessionId correlation. ` +
          `Future activation: Decision: journey-sub-flow-activation-request ` +
          `(auto-promote at >=2 distinct adopter requests).`,
        blocking: true,
        timestamp,
      });
    }

    // Rule 3b — Inheritance violation check for locked fields (§5.3)
    for (const field of JOURNEY_INHERITED_LOCKED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(journey, field)) {
        events.push({
          kind: 'JourneyInheritanceViolation',
          soulId,
          journeyId,
          violationClass: field as JourneyViolationClass,
          message:
            `Journey '${journeyId}' on soul '${soulId}' attempts to override '${field}', ` +
            `which is inherited-and-locked from the parent Soul DID (RFC-0018 §5.3 bounded ` +
            `inheritance table). Remove '${field}' from the journey declaration.`,
          blocking: true,
          timestamp,
        });
      }
    }

    // Rule 3c — complianceFloor check (§5.3)
    // When scope=variant, complianceFloor MUST be 'inherit'.
    // Presence of complianceFloor with any value other than 'inherit' is a violation.
    const isVariantScoped = typeof journey.scope === 'string' && journey.scope.startsWith('variant:');
    if (isVariantScoped && Object.prototype.hasOwnProperty.call(journey, 'complianceFloor')) {
      if (journey.complianceFloor !== 'inherit') {
        events.push({
          kind: 'JourneyInheritanceViolation',
          soulId,
          journeyId,
          violationClass: 'complianceFloor',
          message:
            `Journey '${journeyId}' on soul '${soulId}' has scope '${journey.scope}' ` +
            `(variant-scoped) but declares complianceFloor='${String(journey.complianceFloor)}'. ` +
            `Variant-scoped journeys MUST set complianceFloor='inherit' (RFC-0018 §5.3 — ` +
            `journeys cannot diverge from parent compliance regime). ` +
            `Set complianceFloor: inherit.`,
          blocking: true,
          timestamp,
        });
      }
    }

    // Rule 3d — WCAG level lowering (§5.3)
    // Journeys MAY raise WCAG above parent; MUST NOT lower it.
    if (parentWcagLevel && journey.accessibility?.wcagLevel) {
      const parentOrder = WCAG_LEVEL_ORDER[parentWcagLevel] ?? 0;
      const journeyOrder = WCAG_LEVEL_ORDER[journey.accessibility.wcagLevel] ?? 0;
      if (journeyOrder > 0 && journeyOrder < parentOrder) {
        events.push({
          kind: 'JourneyInheritanceViolation',
          soulId,
          journeyId,
          violationClass: 'wcagLevel-lowered-below-parent',
          message:
            `Journey '${journeyId}' on soul '${soulId}' declares wcagLevel='${journey.accessibility.wcagLevel}', ` +
            `which is LOWER than the parent's wcagLevel='${parentWcagLevel}'. ` +
            `RFC-0018 §5.3: journeys MAY raise WCAG above the parent but MUST NOT lower it. ` +
            `Set wcagLevel to '${parentWcagLevel}' or higher (e.g. 'AAA' for regulatory journeys).`,
          blocking: true,
          timestamp,
        });
      }
    }

    // Rule 3e — State count checks (OQ-2)
    const stateCount = Array.isArray(journey.states) ? journey.states.length : 0;

    if (stateCount >= stateHardLimit) {
      events.push({
        kind: 'JourneyStateCountHardLimitExceeded',
        soulId,
        journeyId,
        stateCount,
        limit: stateHardLimit,
        message:
          `Journey '${journeyId}' on soul '${soulId}' declares ${stateCount} state(s), ` +
          `reaching or exceeding the sanity-guard hard limit of ${stateHardLimit}. ` +
          `Declaration rejected. This limit guards against typos and runaway-loop declarations ` +
          `(NOT an architectural constraint — regulatory journeys with 25-40 states are valid). ` +
          `Decision: journey-state-count-hard-limit-exceeded.`,
        blocking: true,
        timestamp,
      });
    } else if (stateCount >= stateSoftWarnAt) {
      events.push({
        kind: 'JourneyStateCountSoftWarning',
        soulId,
        journeyId,
        stateCount,
        threshold: stateSoftWarnAt,
        message:
          `Journey '${journeyId}' on soul '${soulId}' declares ${stateCount} state(s), ` +
          `at or above the soft-warn threshold of ${stateSoftWarnAt}. ` +
          `Non-blocking review recommended. ` +
          `Decision: journey-state-count-soft-warning.`,
        v1WorkaroundMessage: stateWarnMessage,
        blocking: false,
        timestamp,
      });
    }
  }

  return events;
}

/**
 * Convenience predicate: returns true when any event in the list is blocking.
 * Use to decide whether to reject the Soul DID declaration.
 */
export function hasBlockingJourneyViolations(events: JourneyEvent[]): boolean {
  return events.some((e) => e.blocking);
}

// ── Sub-flow activation counter (OQ-3) ────────────────────────────────────────

/**
 * Represents a single adopter request for journey sub-flow (nested journey)
 * activation. Used by `trackSubFlowActivationRequest` to accumulate distinct
 * adopter signals.
 */
export interface SubFlowActivationRequest {
  /** Adopter identifier (e.g. org slug, soul id, adopter name). Used for deduplication. */
  requestedBy: string;
  /** Journey the request pertains to (for context; not used in deduplication). */
  journeyId?: string;
  /** Soul the request pertains to (for context; not used in deduplication). */
  soulId?: string;
}

/**
 * Track a stage-A counter of distinct adopter requests for journey sub-flow
 * activation (RFC-0018 OQ-3 resolution, AISDLC-465 AC #10).
 *
 * v1 does NOT activate sub-flows — this is a pure counter. Its purpose is to
 * accumulate demand signal until `threshold` distinct adopters have requested
 * the capability, at which point `promotedToOperatorReview: true` signals that
 * a follow-on RFC discussion should be opened.
 *
 * Adopter deduplication is based on `request.requestedBy`. Multiple requests
 * from the same adopter count as one distinct request.
 *
 * All requests route through RFC-0035 G0 (non-blocking pipeline contract).
 *
 * ### Usage
 *
 * ```ts
 * const result = trackSubFlowActivationRequests([
 *   { requestedBy: 'adopter-acme', journeyId: 'onboarding', soulId: 'spry-engage' },
 *   { requestedBy: 'adopter-beta' },
 * ], { distinctAdopterRequestsThreshold: 2 });
 *
 * // result.distinctAdopterCount === 2
 * // result.promotedToOperatorReview === true  (threshold reached)
 * ```
 *
 * @param requests  Accumulated adopter activation requests (may include duplicates).
 * @param config    Per-org counter configuration (threshold defaults to 2).
 */
export function trackSubFlowActivationRequests(
  requests: SubFlowActivationRequest[],
  config: SubFlowActivationConfig = {},
): SubFlowActivationCounterResult {
  const threshold = config.distinctAdopterRequestsThreshold ?? DEFAULT_SUB_FLOW_ACTIVATION_THRESHOLD;

  // Deduplicate by requestedBy — one signal per distinct adopter.
  const distinctAdopters = new Set<string>();
  for (const req of requests) {
    if (req.requestedBy) {
      distinctAdopters.add(req.requestedBy);
    }
  }

  const distinctAdopterCount = distinctAdopters.size;
  const promotedToOperatorReview = distinctAdopterCount >= threshold;

  return {
    decision: 'journey-sub-flow-activation-request',
    distinctAdopterCount,
    threshold,
    promotedToOperatorReview,
    adopters: Array.from(distinctAdopters),
    recommendation: promotedToOperatorReview
      ? `${distinctAdopterCount} distinct adopter(s) have requested journey sub-flow activation ` +
        `(threshold: ${threshold}). Recommended action: file a follow-on RFC to formally ` +
        `evaluate nested journeys with CEL-based composition rules. ` +
        `v1 workaround: model sub-flows as multiple top-level journeys with handoff ` +
        `terminal states using shared userId/sessionId correlation.`
      : `${distinctAdopterCount} of ${threshold} required distinct adopter requests ` +
        `collected for journey sub-flow activation. No operator action needed yet.`,
  };
}

/**
 * Parse a `targetedJourneys` URI entry per RFC-0018 §6.1.
 *
 * Two forms:
 *   - Soul-scoped:    `<soul-id>/<journey-id>`
 *   - Variant-scoped: `<soul-id>/<variant-id>/<journey-id>`
 *
 * Returns `null` when the URI does not match either form.
 */
export interface ParsedTargetedJourneyRef {
  readonly soulId: string;
  readonly variantId?: string;
  readonly journeyId: string;
}

/**
 * Parse a `targetedJourneys` URI entry into its component parts.
 *
 * @param raw  Raw URI string from the work item's `targetedJourneys[]` field.
 * @returns    Parsed components or null if the URI is malformed.
 */
export function parseTargetedJourneyRef(raw: string): ParsedTargetedJourneyRef | null {
  if (!raw || typeof raw !== 'string') return null;

  // Validate against the JSON Schema pattern:
  // ^[a-z][a-z0-9-]*/([a-z][a-z0-9-]*/)?[a-z][a-z0-9-]*$
  const kebab = '[a-z][a-z0-9-]*';
  const pattern = new RegExp(`^(${kebab})/(?:(${kebab})/)?(${kebab})$`);
  const match = raw.match(pattern);
  if (!match) return null;

  const soulId = match[1];
  const middle = match[2]; // present only for variant-scoped form
  const last = match[3];

  if (middle) {
    // Variant-scoped: soul-id/variant-id/journey-id
    return { soulId, variantId: middle, journeyId: last };
  }
  // Soul-scoped: soul-id/journey-id
  return { soulId, journeyId: last };
}
