/**
 * CostTracker — records LLM usage costs, computes summaries,
 * and tracks budget status.
 *
 * RFC reference: Lines 618-720 (cost tracking).
 */

import type { StateStore } from './state/store.js';
import type { CostLedgerEntry } from './state/types.js';
import { DEFAULT_MODEL_COSTS, DEFAULT_COST_BUDGET_USD } from './defaults.js';

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
   * Compute cost in USD from token counts and model name.
   */
  static computeCost(
    inputTokens: number,
    outputTokens: number,
    model: string,
    cacheReadTokens = 0,
  ): number {
    const costs = DEFAULT_MODEL_COSTS[model];
    if (!costs) {
      // Fallback: use sonnet pricing
      const fallback = DEFAULT_MODEL_COSTS['claude-sonnet-4-5-20250929'] ?? {
        inputPer1M: 3,
        outputPer1M: 15,
        cacheReadPer1M: 0.3,
      };
      return (
        (inputTokens * fallback.inputPer1M +
          outputTokens * fallback.outputPer1M +
          cacheReadTokens * (fallback.cacheReadPer1M ?? 0)) /
        1_000_000
      );
    }
    return (
      (inputTokens * costs.inputPer1M +
        outputTokens * costs.outputPer1M +
        cacheReadTokens * (costs.cacheReadPer1M ?? 0)) /
      1_000_000
    );
  }

  /**
   * Record a cost entry.
   */
  recordCost(entry: Omit<CostLedgerEntry, 'id' | 'createdAt'>): number {
    // Auto-compute cost if not provided
    let costUsd = entry.costUsd ?? 0;
    if (costUsd === 0 && entry.model && (entry.inputTokens || entry.outputTokens)) {
      costUsd = CostTracker.computeCost(
        entry.inputTokens ?? 0,
        entry.outputTokens ?? 0,
        entry.model,
        entry.cacheReadTokens ?? 0,
      );
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

    for (const entry of entries) {
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
}
