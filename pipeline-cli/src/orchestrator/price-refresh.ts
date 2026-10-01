/**
 * Daily model price refresh for the orchestrator tick (RFC-0050 A6).
 *
 * Runs `refreshPrices` at most once per calendar day (UTC), counting an attempt
 * rather than a success so a failing source is not retried on every tick.
 * Never throws: a failure here must not disturb the tick.
 */

import {
  defaultPriceSources,
  readPriceFeedState,
  refreshPrices,
  reportCapabilityOutcome,
  type FetchFn,
  type PriceSource,
  type RefreshResult,
  type UsageStoreOptions,
} from '@ai-sdlc/reference';
import type { OrchestratorEvent } from './events.js';

export interface DailyPriceRefreshOptions extends UsageStoreOptions {
  /** Sources in precedence order. Defaults to the shipped sources over `fetch`. */
  sources?: readonly PriceSource[];
  fetch?: FetchFn;
  now?: () => Date;
  emit: (event: Omit<OrchestratorEvent, 'ts'>) => void;
  /** Capability reporting; defaults to the capability registry. */
  onCapability?: (outcome: 'live' | 'degraded', reason?: string) => void;
}

/** Emit `ModelPriceChanged` once per changed token class. */
export function emitPriceChanges(
  changes: RefreshResult['changes'],
  emit: (event: Omit<OrchestratorEvent, 'ts'>) => void,
): void {
  for (const c of changes) {
    emit({
      type: 'ModelPriceChanged',
      model: c.model,
      tokenClass: c.tokenClass,
      oldPrice: c.oldPrice,
      newPrice: c.newPrice,
    });
  }
}

/** Run the refresh unless one was already attempted today. */
export async function runDailyPriceRefresh(
  opts: DailyPriceRefreshOptions,
): Promise<RefreshResult | 'skipped' | 'error'> {
  try {
    const now = (opts.now ?? ((): Date => new Date()))();
    const last = readPriceFeedState(opts).lastAttemptAt;
    if (last && last.slice(0, 10) === now.toISOString().slice(0, 10)) return 'skipped';
    const result = await refreshPrices({
      ...opts,
      sources: opts.sources ?? defaultPriceSources({ fetch: opts.fetch, now: () => now }),
      now: () => now,
      onCapability:
        opts.onCapability ??
        ((outcome, reason): void => reportCapabilityOutcome('pricing.feed', outcome, { reason })),
    });
    emitPriceChanges(result.changes, opts.emit);
    return result;
  } catch {
    return 'error';
  }
}
