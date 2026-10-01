/**
 * CostTracker — records LLM usage costs, computes summaries,
 * and tracks budget status.
 *
 * RFC reference: Lines 618-720 (cost tracking).
 *
 * RFC-0019 §10 / AISDLC-337: embeddingTokens line item added via
 * recordEmbeddingCost(). Embedding costs are recorded with
 * pipelineType='embeddingTokens' and do NOT decrement SubscriptionLedger
 * window quota when adapter billingModel='pay-per-token' (OQ-7 re-walkthrough).
 */

import type { StateStore } from './state/store.js';
import type { CostLedgerEntry } from './state/types.js';
import { DEFAULT_MODEL_COSTS, DEFAULT_COST_BUDGET_USD } from './defaults.js';
import type { EmbeddingCostRecord } from './embedding/types.js';

export interface CostSummary {
  totalCostUsd: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  entryCount: number;
  avgCostPerRun: number;
  avgTokensPerRun: number;
  costByAgent: Record<string, number>;
  costByModel: Record<string, number>;
  /** Models in the period with no known price; their cost is reported as zero, not estimated. */
  unpricedModels?: string[];
  period?: string;
}

export interface BudgetStatus {
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  utilizationPercent: number;
  overBudget: boolean;
  projectedMonthlyUsd: number;
}

export interface CostTimeSeriesPoint {
  date: string;
  costUsd: number;
  tokens: number;
  runCount: number;
}

export class CostTracker {
  constructor(private store: StateStore) {}

  /**
   * Whether `model` has a known price. An unknown model is never priced as
   * another model; it is reported as unpriced.
   */
  static isPriced(model: string): boolean {
    return Object.prototype.hasOwnProperty.call(DEFAULT_MODEL_COSTS, model);
  }

  /**
   * Compute cost in USD from token counts and model name, with an explicit
   * `unpriced` marker. An unknown model yields zero cost and `unpriced: true`.
   */
  static computeCostDetailed(
    inputTokens: number,
    outputTokens: number,
    model: string,
    cacheReadTokens = 0,
  ): { costUsd: number; unpriced: boolean; model: string } {
    if (!CostTracker.isPriced(model)) {
      return { costUsd: 0, unpriced: true, model };
    }
    const costs = DEFAULT_MODEL_COSTS[model];
    const costUsd =
      (inputTokens * costs.inputPer1M +
        outputTokens * costs.outputPer1M +
        cacheReadTokens * (costs.cacheReadPer1M ?? 0)) /
      1_000_000;
    return { costUsd, unpriced: false, model };
  }

  /**
   * Compute cost in USD from token counts and model name. An unknown model
   * costs zero and is not priced as another model; call
   * `computeCostDetailed` (or `isPriced`) to see the `unpriced` marker.
   */
  static computeCost(
    inputTokens: number,
    outputTokens: number,
    model: string,
    cacheReadTokens = 0,
  ): number {
    return CostTracker.computeCostDetailed(inputTokens, outputTokens, model, cacheReadTokens)
      .costUsd;
  }

  /**
   * Record a cost entry.
   */
  recordCost(entry: Omit<CostLedgerEntry, 'id' | 'createdAt'>): number {
    // Auto-compute cost if not provided
    let costUsd = entry.costUsd ?? 0;
    if (costUsd === 0 && entry.model && (entry.inputTokens || entry.outputTokens)) {
      const computed = CostTracker.computeCostDetailed(
        entry.inputTokens ?? 0,
        entry.outputTokens ?? 0,
        entry.model,
        entry.cacheReadTokens ?? 0,
      );
      costUsd = computed.costUsd;
      if (computed.unpriced) {
        process.emitWarning(
          `No price known for model "${entry.model}"; its cost is recorded as zero (unpriced).`,
          'UnpricedModelWarning',
        );
      }
    }

    return this.store.saveCostEntry({
      ...entry,
      costUsd,
      totalTokens: entry.totalTokens ?? (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0),
    });
  }

  /**
   * Get a cost summary for a time range.
   */
  getCostSummary(since?: string): CostSummary {
    const entries = this.store.getCostEntries({ since });
    const dbSummary = this.store.getCostSummary(since);

    const costByAgent: Record<string, number> = {};
    const costByModel: Record<string, number> = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const unpriced = new Set<string>();

    for (const entry of entries) {
      // Unpriced means no known price AND no caller-supplied cost.
      if (entry.model && !CostTracker.isPriced(entry.model) && !entry.costUsd) {
        unpriced.add(entry.model);
      }
      costByAgent[entry.agentName] = (costByAgent[entry.agentName] ?? 0) + (entry.costUsd ?? 0);
      if (entry.model) {
        costByModel[entry.model] = (costByModel[entry.model] ?? 0) + (entry.costUsd ?? 0);
      }
      totalInputTokens += entry.inputTokens ?? 0;
      totalOutputTokens += entry.outputTokens ?? 0;
    }

    const entryCount = dbSummary.entryCount;

    return {
      totalCostUsd: dbSummary.totalCostUsd,
      totalTokens: dbSummary.totalTokens,
      totalInputTokens,
      totalOutputTokens,
      entryCount,
      avgCostPerRun: entryCount > 0 ? dbSummary.totalCostUsd / entryCount : 0,
      avgTokensPerRun: entryCount > 0 ? dbSummary.totalTokens / entryCount : 0,
      costByAgent,
      costByModel,
      ...(unpriced.size > 0 ? { unpricedModels: [...unpriced].sort() } : {}),
      period: since,
    };
  }

  /**
   * Get budget status for a given budget and period.
   */
  getBudgetStatus(budgetUsd?: number, since?: string): BudgetStatus {
    const budget = budgetUsd ?? DEFAULT_COST_BUDGET_USD;
    const summary = this.getCostSummary(since);

    // Project monthly cost based on daily average
    const entries = this.store.getCostEntries({ since });
    let projectedMonthlyUsd = 0;

    if (entries.length > 0) {
      const oldest = entries[entries.length - 1];
      const newest = entries[0];
      if (oldest.createdAt && newest.createdAt) {
        const daySpan = Math.max(
          1,
          (new Date(newest.createdAt).getTime() - new Date(oldest.createdAt).getTime()) /
            (24 * 60 * 60 * 1000),
        );
        const dailyRate = summary.totalCostUsd / daySpan;
        projectedMonthlyUsd = dailyRate * 30;
      }
    }

    return {
      budgetUsd: budget,
      spentUsd: summary.totalCostUsd,
      remainingUsd: Math.max(0, budget - summary.totalCostUsd),
      utilizationPercent: budget > 0 ? (summary.totalCostUsd / budget) * 100 : 0,
      overBudget: summary.totalCostUsd > budget,
      projectedMonthlyUsd,
    };
  }

  /**
   * Get cost breakdown by agent.
   */
  getCostByAgent(
    since?: string,
  ): Record<string, { costUsd: number; tokens: number; runs: number }> {
    const entries = this.store.getCostEntries({ since });
    const result: Record<string, { costUsd: number; tokens: number; runs: number }> = {};

    for (const entry of entries) {
      if (!result[entry.agentName]) {
        result[entry.agentName] = { costUsd: 0, tokens: 0, runs: 0 };
      }
      result[entry.agentName].costUsd += entry.costUsd ?? 0;
      result[entry.agentName].tokens += entry.totalTokens ?? 0;
      result[entry.agentName].runs += 1;
    }

    return result;
  }

  /**
   * Get cost breakdown by pipeline stage.
   */
  getCostByStage(
    since?: string,
  ): Record<string, { costUsd: number; tokens: number; runs: number }> {
    const entries = this.store.getCostEntries({ since });
    const result: Record<string, { costUsd: number; tokens: number; runs: number }> = {};

    for (const entry of entries) {
      const stage = entry.stageName ?? 'unknown';
      if (!result[stage]) {
        result[stage] = { costUsd: 0, tokens: 0, runs: 0 };
      }
      result[stage].costUsd += entry.costUsd ?? 0;
      result[stage].tokens += entry.totalTokens ?? 0;
      result[stage].runs += 1;
    }

    return result;
  }

  /**
   * Get cost time series at a given granularity.
   */
  getCostTimeSeries(
    granularity: 'day' | 'week' | 'month' = 'day',
    since?: string,
  ): CostTimeSeriesPoint[] {
    const entries = this.store.getCostEntries({ since, limit: 10000 });
    const buckets = new Map<string, CostTimeSeriesPoint>();

    for (const entry of entries) {
      if (!entry.createdAt) continue;
      const date = new Date(entry.createdAt);
      let key: string;

      switch (granularity) {
        case 'day':
          key = date.toISOString().split('T')[0];
          break;
        case 'week': {
          const weekStart = new Date(date);
          weekStart.setDate(weekStart.getDate() - weekStart.getDay());
          key = weekStart.toISOString().split('T')[0];
          break;
        }
        case 'month':
          key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          break;
      }

      const existing = buckets.get(key) ?? { date: key, costUsd: 0, tokens: 0, runCount: 0 };
      existing.costUsd += entry.costUsd ?? 0;
      existing.tokens += entry.totalTokens ?? 0;
      existing.runCount += 1;
      buckets.set(key, existing);
    }

    return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Record an embedding cost event per RFC-0019 §10 / AISDLC-337.
   *
   * Records a 'embeddingTokens' line item in the cost ledger with full
   * (provider, modelVersion, accountId, consumerLabel) attribution dimensions
   * per OQ-6 re-walkthrough.
   *
   * When adapter.billingModel === 'pay-per-token', the cost is recorded
   * but does NOT consume SubscriptionLedger window quota (OQ-7 re-walkthrough).
   * When billingModel === 'subscription-quota', callers must separately update
   * the SubscriptionLedger via the inputTokens/outputTokens mechanism.
   *
   * @param record - Embedding cost attribution data from the adapter.
   * @param runId - Pipeline run ID for traceability (optional; defaults to 'embedding').
   */
  recordEmbeddingCost(record: EmbeddingCostRecord, runId = 'embedding'): number {
    // Encoding convention for embeddingTokens line items:
    //   pipelineType = 'embeddingTokens'  ← discriminates from LLM entries
    //   agentName    = consumerLabel       ← per-consumer attribution (OQ-6)
    //   model        = provider@modelVersion ← identifies exact model snapshot
    //   inputTokens  = tokens              ← total embedding tokens consumed
    //   costUsd      = pre-computed by adapter ← $0.02/1M for OpenAI small
    //   stageName    = accountId (or 'self-hosted') ← per-credential attribution
    const entry: Omit<CostLedgerEntry, 'id' | 'createdAt'> = {
      runId,
      agentName: record.consumerLabel,
      pipelineType: 'embeddingTokens',
      model: `${record.provider}@${record.modelVersion}`,
      inputTokens: record.tokens,
      outputTokens: 0,
      totalTokens: record.tokens,
      costUsd: record.costUsd,
      stageName: record.accountId ?? 'self-hosted',
    };

    return this.store.saveCostEntry(entry);
  }

  /**
   * Record one uncached judgment-provider call. Same column-reuse convention as
   * `recordEmbeddingCost`: pipelineType 'judgmentTokens', agentName = consumerLabel,
   * model '<provider>@<modelVersion>'. `costUsd` defaults to the priced rate for
   * `modelVersion`; callers normally pass the provider's declared-rate cost.
   */
  recordJudgmentCost(record: JudgmentCostRecord, runId = 'judgment'): number {
    const costUsd =
      record.costUsd ?? CostTracker.computeCost(record.inputTokens, 0, record.modelVersion);
    const entry: Omit<CostLedgerEntry, 'id' | 'createdAt'> = {
      runId,
      agentName: record.consumerLabel,
      pipelineType: 'judgmentTokens',
      model: `${record.provider}@${record.modelVersion}`,
      inputTokens: record.inputTokens,
      outputTokens: 0,
      totalTokens: record.inputTokens,
      costUsd,
      stageName: record.judgmentId,
    };
    return this.store.saveCostEntry(entry);
  }
}

/** One uncached judgment call, as recorded in the cost ledger. */
export interface JudgmentCostRecord {
  provider: string;
  modelVersion: string;
  consumerLabel: string;
  judgmentId: string;
  inputTokens: number;
  costUsd?: number;
}
