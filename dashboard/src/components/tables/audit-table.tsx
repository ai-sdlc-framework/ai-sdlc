/**
 * Specialized audit log table.
 */

import type { AuditEntry } from '@/app/api/audit/route';

const statusColors: Record<string, string> = {
  completed: '#16a34a',
  running: '#2563eb',
  failed: '#dc2626',
  pending: '#64748b',
  cancelled: '#9ca3af',
};

export function AuditTable({ entries }: { entries: AuditEntry[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
          <th style={{ textAlign: 'left', padding: '8px 12px' }}>Run ID</th>
          <th style={{ textAlign: 'left', padding: '8px 12px' }}>Issue</th>
          <th style={{ textAlign: 'left', padding: '8px 12px' }}>Type</th>
          <th style={{ textAlign: 'left', padding: '8px 12px' }}>Agent</th>
          <th style={{ textAlign: 'left', padding: '8px 12px' }}>Status</th>
          <th style={{ textAlign: 'right', padding: '8px 12px' }}>Cost</th>
          <th style={{ textAlign: 'left', padding: '8px 12px' }}>Started</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
            <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 12 }}>
              {entry.runId.slice(0, 8)}
            </td>
            <td style={{ padding: '8px 12px' }}>
              {entry.issueNumber != null ? `#${entry.issueNumber}` : '-'}
            </td>
            <td style={{ padding: '8px 12px' }}>{entry.pipelineType}</td>
            <td style={{ padding: '8px 12px' }}>{entry.agentName ?? '-'}</td>
            <td style={{ padding: '8px 12px' }}>
              <span style={{ color: statusColors[entry.status] ?? '#64748b' }}>
                {entry.status}
              </span>
            </td>
            <td style={{ textAlign: 'right', padding: '8px 12px' }}>
              {entry.costUsd != null ? `$${entry.costUsd.toFixed(3)}` : '-'}
            </td>
            <td style={{ padding: '8px 12px', fontSize: 12 }}>
              {entry.startedAt ?? '-'}
            </td>
          </tr>
        ))}
        {entries.length === 0 && (
          <tr>
            <td colSpan={7} style={{ padding: 24, textAlign: 'center', color: '#94a3b8' }}>
              No audit entries found.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
