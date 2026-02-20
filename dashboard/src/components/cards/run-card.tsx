/**
 * Pipeline run card.
 */

import type { RunSummary } from '@/lib/types';

const statusColors: Record<string, string> = {
  completed: '#16a34a',
  running: '#2563eb',
  failed: '#dc2626',
  pending: '#64748b',
  cancelled: '#9ca3af',
};

export function RunCard({ run }: { run: RunSummary }) {
  const statusColor = statusColors[run.status] ?? '#64748b';

  return (
    <div
      style={{
        padding: 12,
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        borderLeft: `3px solid ${statusColor}`,
        marginBottom: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{run.runId.slice(0, 8)}</span>
          {run.issueNumber != null && (
            <span style={{ marginLeft: 8, color: '#64748b', fontSize: 12 }}>
              #{run.issueNumber}
            </span>
          )}
        </div>
        <span style={{ fontSize: 12, color: statusColor, fontWeight: 500 }}>{run.status}</span>
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: '#64748b' }}>
        {run.pipelineType}
        {run.agentName && ` / ${run.agentName}`}
        {run.costUsd != null && ` / $${run.costUsd.toFixed(2)}`}
      </div>
    </div>
  );
}
