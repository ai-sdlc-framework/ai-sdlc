/**
 * Autonomy page — agent level history, promotion timeline.
 */

export const dynamic = 'force-dynamic';

import { Header } from '@/components/layout/header';
import { StatCard } from '@/components/cards/stat-card';
import { Timeline, type TimelineEvent } from '@/components/charts/timeline';
import { DataTable, type Column } from '@/components/tables/data-table';
import { getStateStore } from '@/lib/state';

const levelLabels = ['Supervised', 'Assisted', 'Semi-Autonomous', 'Autonomous', 'Fully Autonomous'];

function getAutonomyData() {
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
       FROM autonomy_events ORDER BY created_at DESC LIMIT 50`,
    )
    .all() as Array<Record<string, unknown>>;

  return { agents, events };
}

export default function AutonomyPage() {
  const { agents, events } = getAutonomyData();

  const avgLevel = agents.length > 0
    ? agents.reduce((sum, a) => sum + (a.current_level as number), 0) / agents.length
    : 0;

  const promotions = events.filter((e) => e.event_type === 'promotion').length;
  const demotions = events.filter((e) => e.event_type === 'demotion').length;

  const timelineEvents: TimelineEvent[] = events.slice(0, 20).map((e) => ({
    label: (e.agent_name as string).slice(0, 8),
    timestamp: (e.created_at as string) ?? '',
    type: e.event_type as TimelineEvent['type'],
    fromLevel: e.from_level as number,
    toLevel: e.to_level as number,
  }));

  const agentColumns: Column<Record<string, unknown>>[] = [
    { key: 'agent_name', label: 'Agent' },
    {
      key: 'current_level',
      label: 'Level',
      render: (r) => levelLabels[r.current_level as number] ?? `L${r.current_level}`,
    },
    { key: 'total_tasks', label: 'Tasks', align: 'right' },
    {
      key: 'success_rate',
      label: 'Success %',
      align: 'right',
      render: (r) => {
        const total = (r.total_tasks as number) || 0;
        const success = (r.success_count as number) || 0;
        return total > 0 ? `${((success / total) * 100).toFixed(1)}%` : '-';
      },
    },
    {
      key: 'pr_approval_rate',
      label: 'PR Approval',
      align: 'right',
      render: (r) => {
        const rate = r.pr_approval_rate as number | null;
        return rate != null ? `${(rate * 100).toFixed(0)}%` : '-';
      },
    },
    { key: 'rollback_count', label: 'Rollbacks', align: 'right' },
  ];

  return (
    <div>
      <Header title="Autonomy" subtitle="Agent progression and trust levels" />

      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <StatCard label="Agents" value={agents.length} />
        <StatCard label="Avg Level" value={avgLevel.toFixed(1)} />
        <StatCard label="Promotions" value={promotions} color="#16a34a" />
        <StatCard label="Demotions" value={demotions} color="#dc2626" />
      </div>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Recent Events</h2>
        <Timeline events={timelineEvents} width={700} height={120} />
      </section>

      <section>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Agent Roster</h2>
        <DataTable columns={agentColumns} rows={agents} keyField="agent_name" />
      </section>
    </div>
  );
}
