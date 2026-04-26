/**
 * TierAnalysis aggregator per RFC §14.13. Aggregates QuotaContention events per
 * billing window and produces upgrade/downgrade recommendations consumed by the
 * Slack daily digest and cli-tier-recommendation.
 */

import type { LedgerKey, SubscriptionPlan } from './types.js';

export type Confidence = 'low' | 'medium' | 'high';

export interface ContentionEvent {
  timestamp: string;
  /** Cumulative duration the high-PPA stage waited on hardCap. */
  contentionDurationMs: number;
}

export interface TierAnalysisInput {
  billingPeriod: string;
  ledgerKey: LedgerKey;
  currentPlan: SubscriptionPlan;
  contentionEvents: ContentionEvent[];
  issuesDeferredOffPeak: number;
  issuesBlockedOnHardCap: number;
  /** Candidate plans (typically: registered SubscriptionPlan resources). */
  candidates: SubscriptionPlan[];
}

export interface TierAnalysisResult {
  billingPeriod: string;
  ledgerKey: LedgerKey;
  currentPlan: string;
  currentPlanCostUsd: number;
  contentionEvents: number;
  cumulativeContentionDurationMs: number;
  issuesDeferredOffPeak: number;
  issuesBlockedOnHardCap: number;
  recommendedPlan: string;
  recommendedPlanCostUsd: number;
  projectedTimeSavedMs: number;
  projectedAdditionalIssuesProcessed: number;
  projectedSpilloverSavingsUsd: number;
  confidence: Confidence;
  reasoning: string;
}

/**
 * Reference plan-cost table — the orchestrator typically has these populated from the
 * SubscriptionPlan resources, but ships with sensible defaults so cli-tier-recommendation
 * can produce useful output even on a fresh deployment.
 */
export const PLAN_COSTS_USD: Record<string, number> = {
  'claude-code-pro': 20,
  'claude-code-max-5x': 100,
  'claude-code-max-20x': 200,
  'codex-plus': 20,
  'codex-pro': 200,
  'pay-per-token': 0,
};

const HIGH_CONTENTION_THRESHOLD = 20;
const MEDIUM_CONTENTION_THRESHOLD = 5;

export function analyzeTier(input: TierAnalysisInput): TierAnalysisResult {
  const cumulative = input.contentionEvents.reduce((a, e) => a + e.contentionDurationMs, 0);
  const confidence = confidenceFor(input.contentionEvents.length);
  const currentPlanCost = PLAN_COSTS_USD[input.currentPlan.name] ?? 0;

  // Find the candidate that minimizes expected contention, conservative for downgrades.
  let recommended = input.currentPlan;
  let recommendedCost = currentPlanCost;
  if (input.contentionEvents.length > 0) {
    // Upgrade direction: pick the next plan up.
    const upgrade = nextPlanUp(input.currentPlan, input.candidates);
    if (upgrade) {
      recommended = upgrade;
      recommendedCost = PLAN_COSTS_USD[upgrade.name] ?? currentPlanCost;
    }
  } else if (confidence === 'high') {
    // Possibly recommend downgrade if utilization is consistently low — we don't have
    // utilization in this aggregation; defer to caller to set issuesBlockedOnHardCap=0
    // and contentionEvents=0 explicitly. For now keep currentPlan as the recommendation.
  }

  const reasoning = buildReasoning(input, cumulative, recommended);

  return {
    billingPeriod: input.billingPeriod,
    ledgerKey: input.ledgerKey,
    currentPlan: input.currentPlan.name,
    currentPlanCostUsd: currentPlanCost,
    contentionEvents: input.contentionEvents.length,
    cumulativeContentionDurationMs: cumulative,
    issuesDeferredOffPeak: input.issuesDeferredOffPeak,
    issuesBlockedOnHardCap: input.issuesBlockedOnHardCap,
    recommendedPlan: recommended.name,
    recommendedPlanCostUsd: recommendedCost,
    projectedTimeSavedMs: cumulative * 0.75, // heuristic: upgrade reclaims ~75% of contention
    projectedAdditionalIssuesProcessed: Math.floor(cumulative / (60 * 60 * 1000)), // 1 issue per hour saved
    projectedSpilloverSavingsUsd: input.issuesBlockedOnHardCap * 1.5,
    confidence,
    reasoning,
  };
}

function nextPlanUp(
  current: SubscriptionPlan,
  candidates: SubscriptionPlan[],
): SubscriptionPlan | null {
  const sameHarness = candidates.filter((c) => c.harness === current.harness);
  const ordered = sameHarness.sort(
    (a, b) => (PLAN_COSTS_USD[a.name] ?? 0) - (PLAN_COSTS_USD[b.name] ?? 0),
  );
  const idx = ordered.findIndex((p) => p.name === current.name);
  if (idx < 0 || idx === ordered.length - 1) return null;
  return ordered[idx + 1];
}

function confidenceFor(count: number): Confidence {
  if (count > HIGH_CONTENTION_THRESHOLD) return 'high';
  if (count >= MEDIUM_CONTENTION_THRESHOLD) return 'medium';
  return 'low';
}

function buildReasoning(
  input: TierAnalysisInput,
  cumulativeMs: number,
  recommended: SubscriptionPlan,
): string {
  if (recommended.name === input.currentPlan.name) {
    return `Current plan ${input.currentPlan.name} appears appropriately sized for observed contention (${input.contentionEvents.length} events, ${(cumulativeMs / 1000 / 60 / 60).toFixed(1)}h cumulative).`;
  }
  return `${input.currentPlan.name} hit hardCap on ${input.issuesBlockedOnHardCap} issues this period, totaling ${(cumulativeMs / 1000 / 60 / 60).toFixed(1)}h of cumulative wait. ${recommended.name} would project to keep utilization below pacingTarget at current dispatch rate.`;
}
