/**
 * Reconciliation loop primitives.
 *
 * Implements the controller pattern from spec/spec.md Section 9:
 * desired state -> observe -> diff -> act -> loop
 *
 * The reconciliation engine is level-triggered, idempotent,
 * eventually consistent, and rate-limited with backoff.
 */

import type { AnyResource } from '../core/types.js';
import {
  type ReconcileResult,
  type ReconcilerFn,
  type ReconcilerConfig,
  DEFAULT_RECONCILER_CONFIG,
} from './types.js';

export { type ReconcileResult, type ReconcilerFn, type ReconcilerConfig, DEFAULT_RECONCILER_CONFIG } from './types.js';

/**
 * Calculate exponential backoff with jitter.
 */
export function calculateBackoff(
  attempt: number,
  config: ReconcilerConfig = DEFAULT_RECONCILER_CONFIG,
): number {
  const backoff = Math.min(
    config.initialBackoffMs * Math.pow(2, attempt),
    config.maxBackoffMs,
  );
  // Add up to 10% jitter
  const jitter = backoff * 0.1 * Math.random();
  return Math.floor(backoff + jitter);
}

/**
 * Run a single reconciliation cycle for a resource.
 * Wraps the reconciler function with error handling.
 */
export async function reconcileOnce<R extends AnyResource>(
  resource: R,
  reconciler: ReconcilerFn<R>,
): Promise<ReconcileResult> {
  try {
    return await reconciler(resource);
  } catch (err) {
    return {
      type: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
