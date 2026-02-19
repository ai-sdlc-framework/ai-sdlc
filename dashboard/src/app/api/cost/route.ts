/**
 * GET /api/cost — cost analytics summary.
 */

import { NextResponse } from 'next/server';
import { getStateStore } from '@/lib/state';
import type { CostSummaryResponse } from '@/lib/types';

export async function GET(): Promise<NextResponse<CostSummaryResponse>> {
  const store = getStateStore();

  // Totals
  const totals = store.getDatabase()
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) as total_cost,
              COALESCE(SUM(total_tokens), 0) as total_tokens,
              COUNT(*) as run_count
       FROM cost_ledger`,
    )
    .get() as Record<string, number>;

  // By agent
  const byAgent = store.getDatabase()
    .prepare(
      `SELECT agent_name, COALESCE(SUM(cost_usd), 0) as cost_usd, COUNT(*) as runs
       FROM cost_ledger GROUP BY agent_name ORDER BY cost_usd DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  // By model
  const byModel = store.getDatabase()
    .prepare(
      `SELECT model, COALESCE(SUM(cost_usd), 0) as cost_usd, COUNT(*) as runs
       FROM cost_ledger WHERE model IS NOT NULL GROUP BY model ORDER BY cost_usd DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  // Time series (daily, last 30 days)
  const timeSeries = store.getDatabase()
    .prepare(
      `SELECT DATE(created_at) as date,
              COALESCE(SUM(cost_usd), 0) as cost_usd,
              COUNT(*) as runs
       FROM cost_ledger
       WHERE created_at >= datetime('now', '-30 days')
       GROUP BY DATE(created_at)
       ORDER BY date`,
    )
    .all() as Array<Record<string, unknown>>;

  // Budget status — compute from first entry date
  const dateRange = store.getDatabase()
    .prepare(
      `SELECT MIN(created_at) as first_at, MAX(created_at) as last_at FROM cost_ledger`,
    )
    .get() as Record<string, string | null>;

  const budgetUsd = 500; // DEFAULT_COST_BUDGET_USD
  const spentUsd = totals.total_cost;
  const remainingUsd = Math.max(0, budgetUsd - spentUsd);
  const utilizationPercent = budgetUsd > 0 ? (spentUsd / budgetUsd) * 100 : 0;

  let projectedMonthlyUsd = 0;
  if (dateRange.first_at && dateRange.last_at) {
    const daySpan = Math.max(
      1,
      (new Date(dateRange.last_at).getTime() - new Date(dateRange.first_at).getTime()) /
        (24 * 60 * 60 * 1000),
    );
    projectedMonthlyUsd = (spentUsd / daySpan) * 30;
  }

  const response: CostSummaryResponse = {
    totalCostUsd: totals.total_cost,
    totalTokens: totals.total_tokens,
    runCount: totals.run_count,
    byAgent: byAgent.map((r) => ({
      agentName: r.agent_name as string,
      costUsd: r.cost_usd as number,
      runs: r.runs as number,
    })),
    timeSeries: timeSeries.map((r) => ({
      date: r.date as string,
      costUsd: r.cost_usd as number,
      runs: r.runs as number,
    })),
    byModel: byModel.map((r) => ({
      model: r.model as string,
      costUsd: r.cost_usd as number,
      runs: r.runs as number,
    })),
    budget: {
      budgetUsd,
      spentUsd,
      remainingUsd,
      utilizationPercent,
      overBudget: spentUsd > budgetUsd,
      projectedMonthlyUsd,
    },
  };

  return NextResponse.json(response);
}
