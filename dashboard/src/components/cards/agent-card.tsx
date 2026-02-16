/**
 * Agent status card.
 */

import type { AgentSummary } from '@/lib/types';

const levelLabels = ['Supervised', 'Assisted', 'Semi-Autonomous', 'Autonomous', 'Fully Autonomous'];

export function AgentCard({ agent }: { agent: AgentSummary }) {
  const levelLabel = levelLabels[agent.currentLevel] ?? `Level ${agent.currentLevel}`;
  const successPct = (agent.successRate * 100).toFixed(0);

  return (
    <div style={{
      padding: 12,
      border: '1px solid #e2e8f0',
      borderRadius: 8,
      marginBottom: 8,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{agent.agentName}</span>
        <span style={{
          fontSize: 11,
          padding: '2px 6px',
          borderRadius: 4,
          backgroundColor: '#eff6ff',
          color: '#1d4ed8',
        }}>
          {levelLabel}
        </span>
      </div>
      <div style={{ marginTop: 6, fontSize: 12, color: '#64748b' }}>
        {agent.totalTasks} tasks / {successPct}% success
      </div>
    </div>
  );
}
