/**
 * Burn-down report emitter per RFC §14.4. Produces a snapshot of subscription window
 * state with three pacing recommendations: under-pacing, on-pace, over-pacing.
 * Operators consume these via cli-status --subscriptions and the Slack daily digest.
 */

import type { SubscriptionLedger } from './ledger.js';
import type { BurnDownReport, LedgerKey, SubscriptionPlan } from './types.js';

const UNDER_PACING_DELTA = 0.1;
const OVER_PACING_DELTA = 0.05;

export interface BurnDownInput {
  ledger: SubscriptionLedger;
  ledgerKey: LedgerKey;
  plan: SubscriptionPlan;
  /** Sum of dollars spent on pay-per-token spillover in the current window. */
  dollarsSpent: number;
  /** Informational shadow cost — what subscription work would have cost on pay-per-token. */
  shadowCostUsd: number;
  /** Number of pending stages currently in the dispatch queue. */
  queueDepth: number;
  /**
   * Projected end-of-window utilization given current pace + queued work.
   * If undefined, computed as a linear extrapolation from current consumption rate
   * across the remaining window time.
   */
  projectedUtilization?: number;
  now?: () => Date;
}

export function buildBurnDownReport(input: BurnDownInput): BurnDownReport {
  const now = (input.now ?? (() => new Date()))();
  const ws = input.ledger.windowState(input.ledgerKey, input.plan);
  const projectedUtilization = input.projectedUtilization ?? linearProjection(ws, now);
  const recommendation = recommendationFor(projectedUtilization, ws.pacingTarget);

  return {
    harness: input.ledgerKey.harness,
    ledgerKey: input.ledgerKey,
    windowEnd: ws.windowEnd.toISOString(),
    subscriptionTokensConsumed: ws.consumedTokens,
    quotaTokens: ws.quotaTokens,
    subscriptionUtilizationFraction: ws.utilizationFraction,
    dollarsSpent: input.dollarsSpent,
    shadowCostUsd: input.shadowCostUsd,
    pacingTarget: ws.pacingTarget,
    projectedUtilization,
    queueDepth: input.queueDepth,
    recommendation,
  };
}

function linearProjection(ws: ReturnType<SubscriptionLedger['windowState']>, now: Date): number {
  const elapsed = now.getTime() - ws.windowStart.getTime();
  const total = ws.windowEnd.getTime() - ws.windowStart.getTime();
  if (elapsed <= 0 || total <= 0) return ws.utilizationFraction;
  const projected = ws.utilizationFraction * (total / elapsed);
  return Number.isFinite(projected) ? projected : ws.utilizationFraction;
}

function recommendationFor(
  projected: number,
  pacingTarget: number,
): 'under-pacing' | 'on-pace' | 'over-pacing' {
  if (projected < pacingTarget - UNDER_PACING_DELTA) return 'under-pacing';
  if (projected > pacingTarget + OVER_PACING_DELTA) return 'over-pacing';
  return 'on-pace';
}
