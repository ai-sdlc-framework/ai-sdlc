/**
 * Stale-vector policy resolution per RFC-0019 §9.3 + OQ-2 re-walkthrough.
 *
 * When a read encounters a vector whose (embeddingProvider, embeddingModelVersion)
 * does not match the currently configured adapter, the read path follows one
 * of three policies:
 *
 *  - `lazy`     — re-embed the source text with the current adapter and return
 *                 the new vector. The framework default; favours operator
 *                 convenience over strict provenance.
 *  - `fail-loud` — refuse the comparison and throw `StaleVectorEncountered`.
 *                  Used by consumers like RFC-0009 Eτ_tessellation_drift where
 *                  silently overwriting a historical vector destroys time-series
 *                  signal.
 *  - `inherit`  — defer to the org-level default (and ultimately the framework
 *                 default of `lazy`). Per-consumer call sites typically pass
 *                 `inherit` when they have no opinion.
 *
 * The OQ-2 re-walkthrough resolution added an explicit per-consumer override
 * API parameter on top of the org default. RFC-0009 drift pins `fail-loud` at
 * its call sites; common-case consumers (PPA similarity, DoR dedup, classifier
 * embeddings) leave the default. This module implements the three-layer
 * inheritance chain (per-call → org default → framework default).
 *
 * Cross-cutting framing per RFC-0035 G0: a stale-vector encounter ALWAYS
 * produces a `Decision: stale-vector-encountered` event, regardless of policy.
 * Under `lazy` the event is informational (low severity). Under `fail-loud`
 * the event is HIGH severity and surfaced in the operator batch review.
 *
 * @module embedding/stale-vector
 */

import { EmbeddingError } from './errors.js';

/**
 * Resolved policy that the read path actually applies.
 * Distinct from `StaleVectorPolicyInput` because `inherit` is never the
 * effective policy — it always resolves to either `lazy` or `fail-loud`.
 */
export type StaleVectorPolicy = 'lazy' | 'fail-loud';

/**
 * Policy value callers may pass at the API site.
 * `inherit` means "use the org default (which falls back to framework default)".
 */
export type StaleVectorPolicyInput = StaleVectorPolicy | 'inherit';

/**
 * Framework-level default. Per OQ-2 re-walkthrough: `lazy` because the common
 * case (issue dedup, clarification matching) is operator-interactive daily,
 * while strict-provenance use cases (drift trajectory) are once-a-week
 * analyses. Asymmetric impact warrants asymmetric default.
 */
export const FRAMEWORK_DEFAULT_STALE_VECTOR_POLICY: StaleVectorPolicy = 'lazy';

/**
 * Resolve the effective stale-vector policy from the three-layer chain.
 *
 * Precedence (highest to lowest):
 *   1. `perCallOverride` — the value passed at the embed() / read() call site
 *      (e.g., RFC-0009 drift pins `fail-loud`). `inherit` defers to layer 2.
 *   2. `orgDefault` — per-org configuration (`embedding-config.yaml`
 *      `staleVectorPolicy.default`). Undefined defers to layer 3.
 *   3. Framework default — `FRAMEWORK_DEFAULT_STALE_VECTOR_POLICY` (= `lazy`).
 *
 * @param perCallOverride - Optional per-call override. `inherit` defers up.
 * @param orgDefault - Optional org-level default. Undefined defers to framework.
 * @returns The effective policy: `lazy` or `fail-loud`.
 */
export function resolveStaleVectorPolicy(
  perCallOverride: StaleVectorPolicyInput | undefined,
  orgDefault: StaleVectorPolicy | undefined,
): StaleVectorPolicy {
  if (perCallOverride && perCallOverride !== 'inherit') {
    return perCallOverride;
  }
  if (orgDefault) {
    return orgDefault;
  }
  return FRAMEWORK_DEFAULT_STALE_VECTOR_POLICY;
}

/**
 * Severity used for the `Decision: stale-vector-encountered` catalog event.
 * Mirrors the operator-impact surface — `lazy` runs as a silent informational
 * decision; `fail-loud` is escalated for batch review.
 */
export type StaleVectorDecisionSeverity = 'info' | 'high';

/**
 * Map a resolved policy to the catalog Decision severity per OQ-2 re-walkthrough.
 */
export function severityForPolicy(policy: StaleVectorPolicy): StaleVectorDecisionSeverity {
  return policy === 'fail-loud' ? 'high' : 'info';
}

/**
 * Inputs describing a single stale-vector encounter.
 */
export interface StaleVectorContext {
  /** Provider on the stored entry (e.g., 'openai-text-embedding-ada-002'). */
  storedProvider: string;
  /** Model version on the stored entry. */
  storedModelVersion: string;
  /** Adapter the caller is currently configured to use. */
  currentProvider: string;
  /** Model version on the current adapter. */
  currentModelVersion: string;
  /** SHA-256 of the source text — the lookup key that surfaced the stale entry. */
  textHash: string;
  /**
   * Optional consumer label so the catalog event can be attributed back to
   * the calling subsystem (e.g., 'rfc-0009-tessellation-drift').
   */
  consumerLabel?: string;
}

/**
 * Thrown by the read path when the resolved policy is `fail-loud`.
 * Carries the full context so callers can build a useful operator message.
 */
export class StaleVectorEncountered extends EmbeddingError {
  constructor(public readonly context: StaleVectorContext) {
    super(
      `Stale embedding vector encountered: stored ${context.storedProvider}@${context.storedModelVersion}, ` +
        `current ${context.currentProvider}@${context.currentModelVersion}. ` +
        `Policy 'fail-loud' refuses the comparison. ` +
        `Migrate via: cli-embedding-bump --to ${context.currentProvider}`,
    );
    this.name = 'StaleVectorEncountered';
  }
}

/**
 * Whether a stored entry's provenance matches the current adapter.
 * Returns `true` when both provider and modelVersion match — i.e., the entry
 * is NOT stale and no policy enforcement is needed.
 */
export function isCurrentVector(
  storedProvider: string,
  storedModelVersion: string,
  currentProvider: string,
  currentModelVersion: string,
): boolean {
  return storedProvider === currentProvider && storedModelVersion === currentModelVersion;
}
