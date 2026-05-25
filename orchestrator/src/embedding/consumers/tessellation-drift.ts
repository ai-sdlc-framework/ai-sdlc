/**
 * Spec-level wiring for the `Eτ_tessellation_drift` rule consumer per
 * RFC-0009 Phase 4.2 / RFC-0019 Phase 4 (AISDLC-340).
 *
 * Runtime usage activates when RFC-0009 Phase 4.2 ships (AISDLC-317). The
 * code here is the load-bearing API stub the runtime hooks call:
 *
 *   - `TESSELLATION_DRIFT_CONSUMER_LABEL` is the canonical `consumerLabel`
 *     passed to `adapter.embed()` so cost-tracker records the
 *     drift-attribution dimension per OQ-6 re-walkthrough.
 *
 *   - `TESSELLATION_DRIFT_STALE_VECTOR_POLICY` is the API-site override
 *     per OQ-2 re-walkthrough: drift reads historical trajectory across
 *     successive document revisions; lazy-re-embed is actively destructive
 *     of that signal (silently overwrites old vectors → loses time-series
 *     fidelity). The consumer pins `'fail-loud'` regardless of org default
 *     to preserve historical-trajectory fidelity.
 *
 *   - `embedDriftSignal()` is the consumer-facing helper that wraps the
 *     adapter's embed() call with the consumer label baked in. RFC-0009's
 *     drift-computation pipeline calls THIS function, never adapter.embed()
 *     directly, so the consumerLabel is impossible to forget at the call site.
 *
 * Tests: `tessellation-drift.test.ts`
 */

import type { EmbeddingAdapter } from '../types.js';
import type { EmbeddingStaleVectorPolicy } from '../storage/types.js';

/**
 * Canonical consumer label for cost-tracker attribution. Per OQ-6
 * re-walkthrough, callers pass this string so cost-tracker records the
 * `(provider, modelVersion, accountId, consumerLabel='rfc-0009-tessellation-drift')`
 * dimension and finance can answer "drift cost vs PPA cost" without
 * re-instrumentation.
 */
export const TESSELLATION_DRIFT_CONSUMER_LABEL = 'rfc-0009-tessellation-drift';

/**
 * API-site stale-vector policy override per OQ-2 re-walkthrough. The drift
 * consumer pins `fail-loud` regardless of org default — silent re-embedding
 * destroys the historical-trajectory signal the rule is measuring.
 *
 * Treat this constant as load-bearing: every drift-signal read site MUST
 * read THIS value, not the org default, when deciding policy.
 */
export const TESSELLATION_DRIFT_STALE_VECTOR_POLICY: EmbeddingStaleVectorPolicy = 'fail-loud';

/**
 * Embed a single source text for the Eτ_tessellation_drift rule.
 *
 * RFC-0009's drift-computation pipeline (AISDLC-317, pending) calls THIS
 * helper rather than `adapter.embed()` directly. The helper bakes in the
 * consumer label so cost attribution is correct by construction.
 *
 * The adapter is passed in (not resolved here) because the orchestrator
 * may have a fallback chain — the caller (pipeline runtime) decides which
 * adapter to use; the consumer decides the LABEL and POLICY.
 *
 * @param adapter - Resolved embedding adapter (from `loadEmbeddingFromPipelineSpec`).
 * @param text    - Source text to embed (a tessellation shard, typically).
 * @returns       - Vector emitted by the adapter, length === adapter.dimensions.
 */
export async function embedDriftSignal(adapter: EmbeddingAdapter, text: string): Promise<number[]> {
  return adapter.embed(text, TESSELLATION_DRIFT_CONSUMER_LABEL);
}

/**
 * Consumer descriptor exported for cross-cutting docs/registry purposes.
 * Other consumers (PPA similarity, classifier embeddings, etc.) SHOULD
 * export a similar descriptor so a future `cli-embedding-consumers list`
 * can enumerate every consumer + its pinned policy.
 */
export const TESSELLATION_DRIFT_CONSUMER = {
  label: TESSELLATION_DRIFT_CONSUMER_LABEL,
  staleVectorPolicy: TESSELLATION_DRIFT_STALE_VECTOR_POLICY,
  rationale:
    'Eτ drift reads historical trajectory across successive document revisions; ' +
    'lazy-re-embed silently overwrites old vectors and destroys the time-series signal. ' +
    'Pin fail-loud at the API site (RFC-0019 OQ-2 re-walkthrough).',
  rfc: 'RFC-0009',
  task: 'AISDLC-340',
} as const;
