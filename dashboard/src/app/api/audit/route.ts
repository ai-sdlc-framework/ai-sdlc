/**
 * GET /api/audit — searchable audit trail.
 */

import { NextResponse } from 'next/server';
import { getStateStore } from '@/lib/state';

export interface AuditEntry {
  id: number;
  runId: string;
  issueNumber?: number;
  pipelineType: string;
  status: string;
  agentName?: string;
  costUsd?: number;
  startedAt?: string;
  completedAt?: string;
  gateResults?: string;
}

export interface AuditResponse {
  entries: AuditEntry[];
  total: number;
}

export async function GET(request: Request): Promise<NextResponse<AuditResponse>> {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
  const offset = Number(url.searchParams.get('offset') ?? '0');
  const status = url.searchParams.get('status');
  const agent = url.searchParams.get('agent');

  const store = getStateStore();

  let whereClause = '';
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (agent) {
    conditions.push('agent_name = ?');
    params.push(agent);
  }

  if (conditions.length > 0) {
    whereClause = `WHERE ${conditions.join(' AND ')}`;
  }

  const countRow = store
    .getDatabase()
    .prepare(`SELECT COUNT(*) as total FROM pipeline_runs ${whereClause}`)
    .get(...params) as Record<string, number>;

  const rows = store
    .getDatabase()
    .prepare(
      `SELECT id, run_id, issue_number, pipeline_type, status,
              agent_name, cost_usd, started_at, completed_at, gate_results
       FROM pipeline_runs ${whereClause}
       ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<Record<string, unknown>>;

  return NextResponse.json({
    total: countRow.total,
    entries: rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      issueNumber: r.issue_number as number | undefined,
      pipelineType: r.pipeline_type as string,
      status: r.status as string,
      agentName: r.agent_name as string | undefined,
      costUsd: r.cost_usd as number | undefined,
      startedAt: r.started_at as string | undefined,
      completedAt: r.completed_at as string | undefined,
      gateResults: r.gate_results as string | undefined,
    })),
  });
}
