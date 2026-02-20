/**
 * Overview page — recent runs, agent roster, system health.
 */

export const dynamic = 'force-dynamic';

import { Header } from '@/components/layout/header';
import { StatCard } from '@/components/cards/stat-card';
import { RunCard } from '@/components/cards/run-card';
import { AgentCard } from '@/components/cards/agent-card';
import { getStateStore } from '@/lib/state';
import type { RunSummary, AgentSummary, HealthResponse } from '@/lib/types';

function getHealth(): HealthResponse {
  const store = getStateStore();

  const totals = store
    .getDatabase()
    .prepare(`SELECT COUNT(*) as total FROM pipeline_runs`)
    .get() as Record<string, number>;

  const last24h = store
    .getDatabase()
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
       FROM pipeline_runs
       WHERE started_at >= datetime('now', '-1 day')`,
    )
    .get() as Record<string, number>;

  const agents = store
    .getDatabase()
    .prepare(`SELECT COUNT(*) as count FROM autonomy_ledger`)
    .get() as Record<string, number>;

  const runs24h = last24h.total || 0;
  const failed24h = last24h.failed || 0;
  const failureRate = runs24h > 0 ? failed24h / runs24h : 0;

  let status: HealthResponse['status'] = 'healthy';
  if (failureRate > 0.5) status = 'unhealthy';
  else if (failureRate > 0.2) status = 'degraded';

  return {
    status,
    runsTotal: totals.total,
    runsLast24h: runs24h,
    failureRate24h: failureRate,
    activeAgents: agents.count,
  };
}

function getRecentRuns(limit = 10): RunSummary[] {
  const store = getStateStore();
  const rows = store
    .getDatabase()
    .prepare(
      `SELECT run_id, issue_number, pr_number, pipeline_type, status,
              agent_name, cost_usd, tokens_used, started_at, completed_at
       FROM pipeline_runs ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
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
}

function getAgents(): AgentSummary[] {
  const store = getStateStore();
  const rows = store
    .getDatabase()
    .prepare(
      `SELECT agent_name, current_level, total_tasks, success_count, failure_count, last_task_at
       FROM autonomy_ledger ORDER BY agent_name`,
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((r) => {
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
}

export default function OverviewPage() {
  const health = getHealth();
  const runs = getRecentRuns();
  const agents = getAgents();

  const statusColor =
    health.status === 'healthy' ? '#16a34a' : health.status === 'degraded' ? '#d97706' : '#dc2626';

  return (
    <div>
      <Header title="Overview" subtitle="Pipeline operations at a glance" />

      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <StatCard label="Status" value={health.status} color={statusColor} />
        <StatCard label="Total Runs" value={health.runsTotal} />
        <StatCard label="Runs (24h)" value={health.runsLast24h} />
        <StatCard
          label="Failure Rate (24h)"
          value={`${(health.failureRate24h * 100).toFixed(1)}%`}
          color={health.failureRate24h > 0.2 ? '#dc2626' : '#16a34a'}
        />
        <StatCard label="Active Agents" value={health.activeAgents} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <section>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Recent Runs</h2>
          {runs.length === 0 ? (
            <p style={{ color: '#94a3b8' }}>No pipeline runs yet.</p>
          ) : (
            runs.map((r) => <RunCard key={r.runId} run={r} />)
          )}
        </section>

        <section>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Agent Roster</h2>
          {agents.length === 0 ? (
            <p style={{ color: '#94a3b8' }}>No agents registered.</p>
          ) : (
            agents.map((a) => <AgentCard key={a.agentName} agent={a} />)
          )}
        </section>
      </div>
    </div>
  );
}
