/**
 * RFC-0017 Phase 1 — Variant Inheritance Validator.
 *
 * Implements RFC-0017 §5.3 bounded-inheritance enforcement. A variant MUST NOT
 * attempt to override fields that are inherited from (and locked to) the parent
 * Soul DID. When a violation is detected the validator emits a
 * `VariantInheritanceViolation` event (RFC-0008 §C5 Engineering vertex error).
 *
 * Additionally implements the OQ-1 variant count constraints:
 *   - Soft warn (non-blocking) at `softWarnAt` variants (default 5).
 *   - Hard reject at `hardLimit` variants (default 20).
 *
 * And the OQ-2 nested-variants rejection: schema-enforced flat means a variant
 * declaration MUST NOT contain a nested `variants[]` field.
 *
 * @see spec/rfcs/RFC-0017-in-soul-variant-pattern.md §5.3 + §10.1
 * @see orchestrator/src/variant-admission.ts — Phase 2 admission composite
 */

// ── Inherited (locked) field names per RFC-0017 §5.3 ────────────────────────

/**
 * Fields that are INHERITED from the parent Soul DID and cannot be overridden
 * by any variant declaration. Attempting to declare these fields on a variant
 * triggers a `VariantInheritanceViolation`.
 *
 * Corresponds to the left column of the §5.3 inheritance table.
 */
export const INHERITED_LOCKED_FIELDS = [
  'complianceRegimes',
  'substrateInvariants',
  'tenantQuotaShare',
  'performanceBudgets',
  'observabilityRequirements',
] as const;

export type InheritedLockedField = (typeof INHERITED_LOCKED_FIELDS)[number];

// ── Event types ──────────────────────────────────────────────────────────────

/**
 * Discriminated event kind for variant-level events emitted to events.jsonl.
 */
export type VariantEventKind =
  | 'VariantInheritanceViolation'
  | 'VariantCountSoftWarning'
  | 'VariantCountHardLimitExceeded'
  | 'NestedVariantRejected';

/**
 * Emitted when a variant attempts to override an inherited locked field per
 * RFC-0017 §5.3. This is an Engineering vertex error (RFC-0008 §C5).
 *
 * The result is `blocking: true` — the declaring Soul DID is invalid until
 * the offending override is removed.
 */
export interface VariantInheritanceViolation {
  readonly kind: 'VariantInheritanceViolation';
  /** Identifier of the Soul DID that contains the offending variant. */
  readonly soulId: string;
  /** The variant's `id` field value. */
  readonly variantId: string;
  /** The field name the variant attempted to override. */
  readonly field: InheritedLockedField;
  /** Human-readable description of the violation. */
  readonly message: string;
  /** Always true — inheritance violations are blocking errors. */
  readonly blocking: true;
  readonly timestamp: string;
}

/**
 * Non-blocking warning emitted when a Soul DID's variant count reaches the
 * soft-warn threshold (default 5 per OQ-1). Routes through Decision Catalog
 * as `Decision: variant-count-soft-warning` for operator batch review.
 */
export interface VariantCountSoftWarning {
  readonly kind: 'VariantCountSoftWarning';
  readonly soulId: string;
  readonly variantCount: number;
  readonly threshold: number;
  readonly message: string;
  readonly blocking: false;
  readonly timestamp: string;
}

/**
 * Hard-blocking rejection emitted when a Soul DID's variant count reaches the
 * hard limit (default 20 per OQ-1). The Soul DID declaration is rejected.
 * Routes through Decision Catalog as `Decision: variant-count-hard-limit-exceeded`
 * plus a clarification task recommending multi-soul re-architecture.
 */
export interface VariantCountHardLimitExceeded {
  readonly kind: 'VariantCountHardLimitExceeded';
  readonly soulId: string;
  readonly variantCount: number;
  readonly limit: number;
  readonly message: string;
  readonly blocking: true;
  readonly timestamp: string;
}

/**
 * Emitted when a nested `variants[]` field is detected inside a variant
 * declaration. Schema-enforced flat per RFC-0017 OQ-2. Blocking.
 */
export interface NestedVariantRejected {
  readonly kind: 'NestedVariantRejected';
  readonly soulId: string;
  readonly variantId: string;
  readonly message: string;
  readonly blocking: true;
  readonly timestamp: string;
}

export type VariantEvent =
  | VariantInheritanceViolation
  | VariantCountSoftWarning
  | VariantCountHardLimitExceeded
  | NestedVariantRejected;

// ── Input shape ──────────────────────────────────────────────────────────────

/**
 * Minimal representation of one variant declaration as loaded from a Soul DID.
 * Mirrors the JSON Schema shape at `spec/schemas/design-intent-document.schema.json`
 * `$defs.variantDeclaration`.
 */
export interface VariantDeclarationInput {
  /** Kebab-case variant id. */
  id: string;
  /**
   * Any additional fields present in the raw declaration — used to detect
   * attempts to override locked inherited fields.
   */
  [key: string]: unknown;
}

/**
 * Per-org variant count configuration. Loaded from
 * `.ai-sdlc/variant-config.yaml` (`variant.limits`) with the defaults below.
 */
export interface VariantLimitsConfig {
  /** Non-blocking soft warn threshold. Default: 5. */
  softWarnAt?: number;
  /** Hard-blocking rejection limit. Default: 20. */
  hardLimit?: number;
}

/**
 * Options for `validateVariantDeclarations`.
 */
export interface ValidateVariantDeclarationsOptions {
  /** Identifier of the Soul DID being validated (for event attribution). */
  soulId: string;
  /** Raw variant declarations from the Soul DID's `spec.variants[]`. */
  variants: VariantDeclarationInput[];
  /** Per-org or per-Soul limit overrides. Defaults apply when absent. */
  limits?: VariantLimitsConfig;
  /** ISO 8601 timestamp to stamp on emitted events. Defaults to now. */
  now?: string;
}

// ── Default constants ────────────────────────────────────────────────────────

/** OQ-1 default: soft warn at 5 variants (Miller 7±2 cognitive-load threshold). */
export const DEFAULT_SOFT_WARN_AT = 5;
/** OQ-1 default: hard limit at 20 variants (re-architect-as-multi-soul threshold). */
export const DEFAULT_HARD_LIMIT = 20;

// ── Validator ────────────────────────────────────────────────────────────────

/**
 * Validate a Soul DID's `variants[]` declarations against RFC-0017 §5.3 rules.
 *
 * Returns all emitted events. Callers check `event.blocking` to determine
 * whether the Soul DID should be rejected. Caller's responsibility to write
 * events to events.jsonl via the artifact layer.
 *
 * Validation rules (in order):
 *
 *   1. **Hard-limit check (OQ-1)** — if `variants.length >= hardLimit`, emit
 *      `VariantCountHardLimitExceeded` (blocking). Continue to check individual
 *      variants for completeness of the error report.
 *
 *   2. **Soft-warn check (OQ-1)** — if `variants.length >= softWarnAt` AND
 *      below hard limit, emit `VariantCountSoftWarning` (non-blocking).
 *
 *   3. **Per-variant inheritance check (§5.3)** — for each variant, verify it
 *      does not declare any field from `INHERITED_LOCKED_FIELDS`. Each violation
 *      emits `VariantInheritanceViolation` (blocking).
 *
 *   4. **Nested-variants rejection (OQ-2)** — for each variant, verify it does
 *      not contain a `variants` key. Emits `NestedVariantRejected` (blocking).
 */
export function validateVariantDeclarations(
  options: ValidateVariantDeclarationsOptions,
): VariantEvent[] {
  const { soulId, variants, limits, now } = options;
  const timestamp = now ?? new Date().toISOString();
  const softWarnAt = limits?.softWarnAt ?? DEFAULT_SOFT_WARN_AT;
  const hardLimit = limits?.hardLimit ?? DEFAULT_HARD_LIMIT;

  const events: VariantEvent[] = [];
  const count = variants.length;

  // Rule 1 — Hard limit (OQ-1)
  if (count >= hardLimit) {
    events.push({
      kind: 'VariantCountHardLimitExceeded',
      soulId,
      variantCount: count,
      limit: hardLimit,
      message:
        `Soul '${soulId}' declares ${count} variant(s), reaching or exceeding the hard limit of ` +
        `${hardLimit}. Declaration rejected. Consider re-architecting as multiple Soul DIDs ` +
        `(RFC-0017 §5.5 boundary guidance). Decision: variant-count-hard-limit-exceeded.`,
      blocking: true,
      timestamp,
    });
  } else if (count >= softWarnAt) {
    // Rule 2 — Soft warn (OQ-1, non-blocking)
    events.push({
      kind: 'VariantCountSoftWarning',
      soulId,
      variantCount: count,
      threshold: softWarnAt,
      message:
        `Soul '${soulId}' declares ${count} variant(s), at or above the soft-warn threshold of ` +
        `${softWarnAt}. Non-blocking review recommended. Decision: variant-count-soft-warning.`,
      blocking: false,
      timestamp,
    });
  }

  // Rules 3 + 4 — Per-variant checks
  for (const variant of variants) {
    const variantId = String(variant.id ?? '<unknown>');

    // Rule 3 — Inheritance violation check (§5.3)
    for (const field of INHERITED_LOCKED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(variant, field)) {
        events.push({
          kind: 'VariantInheritanceViolation',
          soulId,
          variantId,
          field,
          message:
            `Variant '${variantId}' on soul '${soulId}' attempts to override '${field}', ` +
            `which is inherited-and-locked from the parent Soul DID (RFC-0017 §5.3 bounded ` +
            `inheritance table). Remove '${field}' from the variant declaration.`,
          blocking: true,
          timestamp,
        });
      }
    }

    // Rule 4 — Nested variants rejection (OQ-2)
    if (Object.prototype.hasOwnProperty.call(variant, 'variants')) {
      events.push({
        kind: 'NestedVariantRejected',
        soulId,
        variantId,
        message:
          `Variant '${variantId}' on soul '${soulId}' declares a nested 'variants[]' field. ` +
          `RFC-0017 OQ-2 resolution mandates schema-enforced flat: variants cannot contain ` +
          `sub-variants in v1. Remove the nested 'variants' field.`,
        blocking: true,
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
export function hasBlockingViolations(events: VariantEvent[]): boolean {
  return events.some((e) => e.blocking);
}
