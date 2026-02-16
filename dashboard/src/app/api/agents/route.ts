/**
 * GET /api/agents — list agents from the autonomy ledger.
 */

import { NextResponse } from 'next/server';
import { getStateStore } from '@/lib/state';
import type { AgentSummary } from '@/lib/types';

export async function GET(): Promise<NextResponse<AgentSummary[]>> {
  const store = getStateStore();
  const rows = store.getDatabase()
    .prepare(
      `SELECT agent_name, current_level, total_tasks, success_count, failure_count, last_task_at
       FROM autonomy_ledger ORDER BY agent_name`,
    )
    .all() as Array<Record<string, unknown>>;

  const agents: AgentSummary[] = rows.map((r) => {
    const total = (r.total_tasks as number) || 0;
    const success = (r.success_count as number) || 0;
    return {
      agentName: r.agent_name as string,
      currentLevel: r.current_level as number,
      totalTasks: total,
      successRate: total > 0 ? success / total : 0,
      lastTaskAt: r.last_task_at as string | undefined,
    };
  });

  return NextResponse.json(agents);
}
