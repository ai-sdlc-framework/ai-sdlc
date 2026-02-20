/**
 * Audit trail page — searchable pipeline run log with filters.
 */

export const dynamic = 'force-dynamic';

import { Header } from '@/components/layout/header';
import { AuditTable } from '@/components/tables/audit-table';
import { StatCard } from '@/components/cards/stat-card';
import type { AuditEntry } from '@/app/api/audit/route';
import { getStateStore } from '@/lib/state';

function getAuditData() {
  const store = getStateStore();

  const entries = store
    .getDatabase()
    .prepare(
      `SELECT id, run_id, issue_number, pipeline_type, status,
              agent_name, cost_usd, started_at, completed_at, gate_results
       FROM pipeline_runs ORDER BY started_at DESC LIMIT 100`,
    )
    .all() as Array<Record<string, unknown>>;

  const stats = store
    .getDatabase()
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
              COUNT(DISTINCT agent_name) as agents
       FROM pipeline_runs`,
    )
    .get() as Record<string, number>;

  return { entries, stats };
}

export default function AuditPage() {
  const { entries, stats } = getAuditData();

  const auditEntries: AuditEntry[] = entries.map((r) => ({
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
  }));

  return (
    <div>
      <Header title="Audit Trail" subtitle="Complete pipeline execution history" />

      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <StatCard label="Total Runs" value={stats.total || 0} />
        <StatCard label="Completed" value={stats.completed || 0} color="#16a34a" />
        <StatCard label="Failed" value={stats.failed || 0} color="#dc2626" />
        <StatCard label="Agents Used" value={stats.agents || 0} />
      </div>

      <section>
        <AuditTable entries={auditEntries} />
      </section>
    </div>
  );
}
