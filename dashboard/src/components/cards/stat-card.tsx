/**
 * Summary statistic card.
 */

interface StatCardProps {
  label: string;
  value: string | number;
  detail?: string;
  color?: string;
}

export function StatCard({ label, value, detail, color = '#0f172a' }: StatCardProps) {
  return (
    <div
      style={{
        padding: 16,
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        minWidth: 140,
      }}
    >
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
      {detail && <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>{detail}</div>}
    </div>
  );
}
