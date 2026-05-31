/**
 * RFC-0017 Phase 5 — OQ-8 cardinality activation Decision wiring (AISDLC-438).
 *
 * Per OQ-8 resolution (2026-05-18):
 *
 *   "Future Decision in catalog; auto-promote on ≥2 adopter requests. Author's
 *    threshold expressed through the Decision Catalog substrate. Each adopter
 *    request → `Decision: variant-cardinality-activation-request` → Stage A
 *    counter; at threshold, Decision auto-promotes to operator batch review with
 *    'file follow-on RFC' recommendation."
 *
 * This module implements:
 *
 *   1. **Stage A counter** — tracks distinct adopter cardinality activation
 *      requests. Each request emits `variant-cardinality-activation-request` to
 *      the Decision Catalog substrate. Requests from the same adopter are
 *      deduplicated (one signal per distinct adopter, per OQ-8 intent).
 *
 *   2. **Auto-promote at threshold** — when `distinctAdopterCount >= threshold`
 *      (default 2), the result is marked `promotedToOperatorReview: true` with
 *      a recommendation to file a follow-on RFC for cardinality activation.
 *      This mirrors the RFC-0036 OQ-6 first-party-adapter graduation pattern.
 *
 *   3. **Operator runbook pointer** — the recommendation string references the
 *      canonical runbook path for the "file follow-on RFC" path.
 *
 * All events route through RFC-0035 G0 (non-blocking pipeline contract).
 * The cardinality `field` itself (`primary | secondary | experimental`) is
 * RESERVED in the schema and ignored at runtime in v1.
 *
 * @see spec/rfcs/RFC-0017-in-soul-variant-pattern.md OQ-8 + §5.2
 * @see spec/rfcs/RFC-0035-decision-catalog-operator-routing.md G0 §6.2
 * @see docs/operations/variant-pattern-promotion.md — cardinality activation section
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Minimum number of distinct adopter requests before the cardinality
 * activation Decision auto-promotes to operator batch review (OQ-8 threshold).
 *
 * Mirrors RFC-0036 OQ-6 first-party-adapter graduation threshold pattern.
 * Two distinct adopters requesting the same capability is sufficient signal
 * to bring the topic to operator attention for follow-on RFC consideration.
 */
export const DEFAULT_CARDINALITY_ACTIVATION_THRESHOLD = 2;

// ── Input types ───────────────────────────────────────────────────────────────

/**
 * A single adopter's request to activate the `cardinality` field
 * (`primary | secondary | experimental`) on Soul Variants.
 *
 * Each request is a signal from an InternalAdopter or external operator that
 * their use case requires lifecycle distinctions beyond the flat v1 schema.
 */
export interface CardinalityActivationRequest {
  /** Adopter identifier (e.g. org slug, adopter name). Used for deduplication. */
  requestedBy: string;
  /** Soul the request pertains to (for context; not used in deduplication). */
  soulId: string;
  /** Variant the request pertains to (for context). */
  variantId: string;
  /**
   * Free-text rationale for why cardinality activation would help this adopter.
   * This text surfaces in the operator batch review when promoted.
   */
  rationale: string;
  /** ISO 8601 timestamp of when the request was submitted. */
  requestedAt: string;
}

// ── Output types ──────────────────────────────────────────────────────────────

/**
 * Result of processing a batch of cardinality activation requests.
 * Returned by `trackCardinalityActivationRequest()`.
 */
export interface CardinalityActivationResult {
  /** Decision kind emitted to the catalog per OQ-8 resolution. */
  decisionKind: 'variant-cardinality-activation-request';

  /** Total number of raw requests processed (may include duplicates). */
  totalRequests: number;

  /** Number of distinct adopters (deduplicated by `requestedBy`). */
  distinctAdopterCount: number;

  /** The distinct adopter IDs contributing to this batch. */
  distinctAdopters: string[];

  /**
   * Whether the threshold has been crossed and the Decision has been
   * auto-promoted to operator batch review.
   */
  promotedToOperatorReview: boolean;

  /**
   * Human-readable recommendation surfaced in the operator batch review
   * when `promotedToOperatorReview === true`. Undefined when below threshold.
   */
  recommendation?: string;

  /**
   * The activation threshold that was applied (default 2, per-org configurable).
   */
  threshold: number;

  /**
   * RFC-0035 G0: routing is non-blocking — the pipeline continues regardless
   * of how many requests have been received. The operator batch review is
   * informational, not a gate.
   */
  routing: {
    blocking: false;
    routingKind: 'decision-catalog-auto-promote';
  };
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Track a batch of cardinality activation requests and emit Stage A counter
 * state per OQ-8 resolution.
 *
 * Deduplicates by `requestedBy` — multiple requests from the same adopter
 * count as one distinct signal (preventing a single eager adopter from
 * triggering the promotion threshold alone).
 *
 * When `distinctAdopterCount >= threshold`, marks `promotedToOperatorReview: true`
 * and populates `recommendation` with the "file follow-on RFC" runbook pointer.
 *
 * @param requests  - One or more adopter cardinality activation requests.
 * @param threshold - Override for the activation threshold (default: 2).
 */
export function trackCardinalityActivationRequest(
  requests: CardinalityActivationRequest[],
  threshold: number = DEFAULT_CARDINALITY_ACTIVATION_THRESHOLD,
): CardinalityActivationResult {
  const seenAdopters = new Set<string>();

  for (const req of requests) {
    seenAdopters.add(req.requestedBy);
  }

  const distinctAdopterCount = seenAdopters.size;
  const distinctAdopters = [...seenAdopters].sort();
  const promotedToOperatorReview = distinctAdopterCount >= threshold;

  const recommendation = promotedToOperatorReview
    ? [
        `Cardinality activation threshold reached (${distinctAdopterCount}/${threshold} distinct adopters).`,
        `Operator action: file a follow-on RFC to activate 'cardinality: primary | secondary | experimental'`,
        `on Soul Variants. See docs/operations/variant-pattern-promotion.md §Cardinality Activation`,
        `for the "file follow-on RFC" runbook path.`,
        `Requesting adopters: ${distinctAdopters.join(', ')}.`,
      ].join(' ')
    : undefined;

  return {
    decisionKind: 'variant-cardinality-activation-request',
    totalRequests: requests.length,
    distinctAdopterCount,
    distinctAdopters,
    promotedToOperatorReview,
    recommendation,
    threshold,
    routing: {
      blocking: false,
      routingKind: 'decision-catalog-auto-promote',
    },
  };
}

/**
 * Convenience predicate: returns true when the cardinality activation result
 * should be surfaced to the operator in the next batch review cycle.
 *
 * This is a thin wrapper over `result.promotedToOperatorReview` for
 * callers that need a typed boolean predicate.
 */
export function shouldPromoteToOperatorReview(result: CardinalityActivationResult): boolean {
  return result.promotedToOperatorReview;
}
