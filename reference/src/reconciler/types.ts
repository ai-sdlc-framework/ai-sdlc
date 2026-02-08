/**
 * Reconciliation loop types from spec/spec.md Section 9.
 */

import type { AnyResource } from '../core/types.js';

/**
 * Result of a single reconciliation cycle.
 * Maps to the four outcomes defined in spec Section 9.3.
 */
export type ReconcileResult =
  | { type: 'success' }
  | { type: 'error'; error: Error; retryAfterMs?: number }
  | { type: 'requeue' }
  | { type: 'requeue-after'; delayMs: number };

/**
 * A reconciler function processes a single resource and returns a result.
 * Implementations MUST be idempotent (spec Section 9.2).
 */
export type ReconcilerFn<R extends AnyResource = AnyResource> = (
  resource: R,
) => Promise<ReconcileResult>;

/**
 * Configuration for the reconciliation engine.
 */
export interface ReconcilerConfig {
  /** Base interval for periodic reconciliation (ms). */
  periodicIntervalMs: number;

  /** Maximum backoff duration on error (ms). */
  maxBackoffMs: number;

  /** Initial backoff duration on error (ms). */
  initialBackoffMs: number;

  /** Maximum concurrent reconciliations. */
  maxConcurrency: number;
}

export const DEFAULT_RECONCILER_CONFIG: ReconcilerConfig = {
  periodicIntervalMs: 30_000,
  maxBackoffMs: 300_000,
  initialBackoffMs: 1_000,
  maxConcurrency: 10,
};
