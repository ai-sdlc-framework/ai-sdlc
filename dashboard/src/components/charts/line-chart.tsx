/**
 * SVG line chart component.
 */

export interface LineChartDatum {
  label: string;
  value: number;
}

interface LineChartProps {
  data: LineChartDatum[];
  width?: number;
  height?: number;
  lineColor?: string;
  fillColor?: string;
}

export function LineChart({
  data,
  width = 400,
  height = 200,
  lineColor = '#3b82f6',
  fillColor = '#3b82f620',
}: LineChartProps) {
  if (data.length === 0) return <svg width={width} height={height} />;

  const padding = { top: 10, right: 10, bottom: 30, left: 50 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const step = chartW / Math.max(data.length - 1, 1);

  const points = data.map((d, i) => ({
    x: i * step,
    y: chartH - (d.value / maxVal) * chartH,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1].x},${chartH} L${points[0].x},${chartH} Z`;

  return (
    <svg width={width} height={height} role="img" aria-label="Line chart">
      <g transform={`translate(${padding.left},${padding.top})`}>
        <path d={areaPath} fill={fillColor} />
        <path d={linePath} fill="none" stroke={lineColor} strokeWidth={2} />
        {points.map((p, i) => (
          <circle key={data[i].label} cx={p.x} cy={p.y} r={3} fill={lineColor} />
        ))}
        {/* X labels */}
        {data.map((d, i) => (
          <text
            key={d.label}
            x={i * step}
            y={chartH + 16}
            textAnchor="middle"
            fontSize={10}
            fill="#64748b"
          >
            {d.label}
          </text>
        ))}
        {/* Axes */}
        <line x1={0} y1={0} x2={0} y2={chartH} stroke="#e2e8f0" />
        <line x1={0} y1={chartH} x2={chartW} y2={chartH} stroke="#e2e8f0" />
      </g>
    </svg>
  );
}
