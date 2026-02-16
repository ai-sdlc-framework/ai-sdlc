/**
 * SVG timeline component for autonomy events.
 */

export interface TimelineEvent {
  label: string;
  timestamp: string;
  type: 'promotion' | 'demotion' | 'evaluation' | 'reset';
  fromLevel: number;
  toLevel: number;
}

interface TimelineProps {
  events: TimelineEvent[];
  width?: number;
  height?: number;
}

const typeColors: Record<string, string> = {
  promotion: '#16a34a',
  demotion: '#dc2626',
  evaluation: '#2563eb',
  reset: '#64748b',
};

export function Timeline({ events, width = 600, height = 120 }: TimelineProps) {
  if (events.length === 0) return <svg width={width} height={height} />;

  const padding = { left: 20, right: 20, top: 20, bottom: 30 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const step = events.length > 1 ? chartW / (events.length - 1) : chartW / 2;

  return (
    <svg width={width} height={height} role="img" aria-label="Timeline">
      <g transform={`translate(${padding.left},${padding.top})`}>
        {/* Horizontal baseline */}
        <line x1={0} y1={chartH / 2} x2={chartW} y2={chartH / 2} stroke="#e2e8f0" strokeWidth={2} />

        {events.map((event, i) => {
          const x = events.length > 1 ? i * step : chartW / 2;
          const color = typeColors[event.type] ?? '#64748b';
          const yOffset = event.type === 'promotion' ? -10 : event.type === 'demotion' ? 10 : 0;

          return (
            <g key={`${event.timestamp}-${i}`}>
              <circle cx={x} cy={chartH / 2 + yOffset} r={6} fill={color} />
              <text
                x={x}
                y={chartH / 2 + yOffset - 12}
                textAnchor="middle"
                fontSize={9}
                fill={color}
                fontWeight={500}
              >
                L{event.fromLevel}→L{event.toLevel}
              </text>
              <text
                x={x}
                y={chartH + 10}
                textAnchor="middle"
                fontSize={8}
                fill="#94a3b8"
              >
                {event.label}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
