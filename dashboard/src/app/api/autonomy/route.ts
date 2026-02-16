/**
 * GET /api/autonomy — autonomy level history and events.
 */

import { NextResponse } from 'next/server';
import { getStateStore } from '@/lib/state';

export interface AutonomyResponse {
  agents: Array<{
    agentName: string;
    currentLevel: number;
    totalTasks: number;
    successRate: number;
    prApprovalRate: number | null;
    rollbackCount: number;
    timeAtLevelMs: number;
  }>;
  events: Array<{
    agentName: string;
    eventType: string;
    fromLevel: number;
    toLevel: number;
    trigger?: string;
    createdAt?: string;
  }>;
}

export async function GET(): Promise<NextResponse<AutonomyResponse>> {
  const store = getStateStore();

  const agents = store.getDatabase()
    .prepare(
      `SELECT agent_name, current_level, total_tasks, success_count,
              failure_count, pr_approval_rate, rollback_count, time_at_level_ms
       FROM autonomy_ledger ORDER BY agent_name`,
    )
    .all() as Array<Record<string, unknown>>;

  const events = store.getDatabase()
    .prepare(
      `SELECT agent_name, event_type, from_level, to_level, trigger, created_at
       FROM autonomy_events ORDER BY created_at DESC LIMIT 100`,
    )
    .all() as Array<Record<string, unknown>>;

  return NextResponse.json({
    agents: agents.map((r) => {
      const total = (r.total_tasks as number) || 0;
      const success = (r.success_count as number) || 0;
      return {
        agentName: r.agent_name as string,
        currentLevel: r.current_level as number,
        totalTasks: total,
        successRate: total > 0 ? success / total : 0,
        prApprovalRate: r.pr_approval_rate as number | null,
        rollbackCount: (r.rollback_count as number) || 0,
        timeAtLevelMs: (r.time_at_level_ms as number) || 0,
      };
    }),
    events: events.map((r) => ({
      agentName: r.agent_name as string,
      eventType: r.event_type as string,
      fromLevel: r.from_level as number,
      toLevel: r.to_level as number,
      trigger: r.trigger as string | undefined,
      createdAt: r.created_at as string | undefined,
    })),
  });
}
