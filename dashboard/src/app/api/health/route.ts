/**
 * GET /api/health — system health overview.
 */

import { NextResponse } from 'next/server';
import { getStateStore } from '@/lib/state';
import type { HealthResponse } from '@/lib/types';

export async function GET(): Promise<NextResponse<HealthResponse>> {
  const store = getStateStore();

  const totals = store.getDatabase()
    .prepare(`SELECT COUNT(*) as total FROM pipeline_runs`)
    .get() as Record<string, number>;

  const last24h = store.getDatabase()
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
       FROM pipeline_runs
       WHERE started_at >= datetime('now', '-1 day')`,
    )
    .get() as Record<string, number>;

  const agents = store.getDatabase()
    .prepare(`SELECT COUNT(*) as count FROM autonomy_ledger`)
    .get() as Record<string, number>;

  const runs24h = last24h.total || 0;
  const failed24h = last24h.failed || 0;
  const failureRate = runs24h > 0 ? failed24h / runs24h : 0;

  let status: HealthResponse['status'] = 'healthy';
  if (failureRate > 0.5) status = 'unhealthy';
  else if (failureRate > 0.2) status = 'degraded';

  return NextResponse.json({
    status,
    runsTotal: totals.total,
    runsLast24h: runs24h,
    failureRate24h: failureRate,
    activeAgents: agents.count,
  });
}
