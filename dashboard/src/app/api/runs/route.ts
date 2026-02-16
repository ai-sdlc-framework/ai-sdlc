/**
 * GET /api/runs — list recent pipeline runs.
 */

import { NextResponse } from 'next/server';
import { getStateStore } from '@/lib/state';
import type { RunSummary } from '@/lib/types';

export async function GET(request: Request): Promise<NextResponse<RunSummary[]>> {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);

  const store = getStateStore();
  const rows = store.getDatabase()
    .prepare(
      `SELECT run_id, issue_number, pr_number, pipeline_type, status,
              agent_name, cost_usd, tokens_used, started_at, completed_at
       FROM pipeline_runs ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;

  const runs: RunSummary[] = rows.map((r) => ({
    runId: r.run_id as string,
    issueNumber: r.issue_number as number | undefined,
    prNumber: r.pr_number as number | undefined,
    pipelineType: r.pipeline_type as string,
    status: r.status as string,
    agentName: r.agent_name as string | undefined,
    costUsd: r.cost_usd as number | undefined,
    tokensUsed: r.tokens_used as number | undefined,
    startedAt: r.started_at as string | undefined,
    completedAt: r.completed_at as string | undefined,
  }));

  return NextResponse.json(runs);
}
