/**
 * SVG bar chart component.
 */

export interface BarChartDatum {
  label: string;
  value: number;
  color?: string;
}

interface BarChartProps {
  data: BarChartDatum[];
  width?: number;
  height?: number;
  barColor?: string;
}

export function BarChart({
  data,
  width = 400,
  height = 200,
  barColor = '#3b82f6',
}: BarChartProps) {
  if (data.length === 0) return <svg width={width} height={height} />;

  const padding = { top: 10, right: 10, bottom: 30, left: 50 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const barWidth = chartW / data.length * 0.8;
  const gap = chartW / data.length * 0.2;

  return (
    <svg width={width} height={height} role="img" aria-label="Bar chart">
      <g transform={`translate(${padding.left},${padding.top})`}>
        {data.map((d, i) => {
          const barH = (d.value / maxVal) * chartH;
          const x = i * (barWidth + gap) + gap / 2;
          const y = chartH - barH;
          return (
            <g key={d.label}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barH}
                fill={d.color ?? barColor}
                rx={2}
              />
              <text
                x={x + barWidth / 2}
                y={chartH + 16}
                textAnchor="middle"
                fontSize={10}
                fill="#64748b"
              >
                {d.label}
              </text>
              <text
                x={x + barWidth / 2}
                y={y - 4}
                textAnchor="middle"
                fontSize={10}
                fill="#334155"
              >
                {d.value.toFixed(d.value < 10 ? 2 : 0)}
              </text>
            </g>
          );
        })}
        {/* Y-axis */}
        <line x1={0} y1={0} x2={0} y2={chartH} stroke="#e2e8f0" />
        <line x1={0} y1={chartH} x2={chartW} y2={chartH} stroke="#e2e8f0" />
      </g>
    </svg>
  );
}
