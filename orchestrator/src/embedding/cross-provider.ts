/**
 * Cross-provider compatibility per RFC-0019 §9.3 + OQ-3 re-walkthrough split.
 *
 * The OQ-3 re-walkthrough resolution surfaces a critical distinction that
 * v0.2 missed: cross-PROVIDER comparisons (openai vs cohere) are NEVER valid
 * because the math is genuinely undefined — vectors in different embedding
 * spaces have no metrically-valid distance. cross-VERSION-within-provider
 * comparisons (3-small@2024-01-25 vs 3-small@2025-01-25) DELEGATE to the
 * stale-vector policy because closely-correlated embedding spaces support
 * lazy re-embed.
 *
 * Policy mapping:
 *
 *   stored.provider != current.provider  → ALWAYS REFUSE + emit
 *                                          `Decision: cross-provider-comparison-attempted`
 *                                          → auto-action: emit cli-embedding-bump
 *                                            migration task
 *
 *   stored.provider == current.provider
 *   AND
 *   stored.modelVersion != current.modelVersion → DELEGATE to staleVectorPolicy
 *
 *   stored matches current entirely               → COMPATIBLE (no policy)
 *
 * This resolves v0.2's logical conflict where both cases were lumped under
 * "strict no-op" contradicting OQ-2's lazy-re-embed default.
 *
 * @module embedding/cross-provider
 */

import { EmbeddingError } from './errors.js';

/**
 * The three possible outcomes of a provider-compatibility check.
 *
 *  - `compatible`               — same provider AND same model version. Caller
 *                                 may compare vectors directly.
 *  - `cross-version`            — same provider, different model version.
 *                                 Caller MUST consult the stale-vector policy.
 *  - `cross-provider`           — different provider. Caller MUST refuse the
 *                                 comparison and emit a catalog Decision +
 *                                 migration task.
 */
export type ProviderCompatibility = 'compatible' | 'cross-version' | 'cross-provider';

/**
 * Compare a stored entry's provenance against the currently configured adapter.
 * Pure function — no side effects, no event emission. Callers wrap the result
 * with their own catalog logging.
 */
export function checkProviderCompatibility(
  storedProvider: string,
  storedModelVersion: string,
  currentProvider: string,
  currentModelVersion: string,
): ProviderCompatibility {
  if (storedProvider !== currentProvider) {
    return 'cross-provider';
  }
  if (storedModelVersion !== currentModelVersion) {
    return 'cross-version';
  }
  return 'compatible';
}

/**
 * Thrown when a cross-PROVIDER comparison is attempted (e.g., openai vs cohere).
 * Always fatal — the math is undefined and there is no auto-migration path.
 * Operators must run cli-embedding-bump to re-embed the entire corpus on the
 * new provider.
 */
export class CrossProviderComparisonError extends EmbeddingError {
  constructor(
    public readonly storedProvider: string,
    public readonly currentProvider: string,
    public readonly textHash?: string,
  ) {
    super(
      `Cross-provider comparison refused: stored vector is from '${storedProvider}', ` +
        `current adapter is '${currentProvider}'. Embedding spaces are not metrically ` +
        `comparable across providers. Migrate via: cli-embedding-bump --to ${currentProvider}` +
        (textHash ? ` (offending textHash: ${textHash})` : ''),
    );
    this.name = 'CrossProviderComparisonError';
  }
}

/**
 * Build the catalog Decision payload for a cross-provider attempt per
 * RFC-0019 §9.3 OQ-3 re-walkthrough. The caller forwards this to
 * `appendDecisionEvent()` so a `Decision: cross-provider-comparison-attempted`
 * lands in the catalog and the operator gets a migration task.
 */
export interface CrossProviderDecisionPayload {
  /** Stable summary used as the catalog Decision summary. */
  summary: string;
  /** Suggested migration command. */
  migrationCommand: string;
  /** Severity — always high for cross-provider. */
  severity: 'high';
  /** Auto-action — always emit a cli-embedding-bump migration task. */
  autoAction: 'emit-migration-task';
}

export function buildCrossProviderDecisionPayload(
  storedProvider: string,
  currentProvider: string,
): CrossProviderDecisionPayload {
  return {
    summary:
      `Cross-provider comparison attempted: '${storedProvider}' vs '${currentProvider}'. ` +
      `Refused (math undefined). Run cli-embedding-bump to migrate.`,
    migrationCommand: `cli-embedding-bump --to ${currentProvider}`,
    severity: 'high',
    autoAction: 'emit-migration-task',
  };
}
