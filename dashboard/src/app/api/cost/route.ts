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
  };

  return NextResponse.json(response);
}
