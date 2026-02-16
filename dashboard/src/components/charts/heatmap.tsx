/**
 * SVG heatmap component for hotspots.
 */

export interface HeatmapCell {
  label: string;
  value: number;
}

interface HeatmapProps {
  data: HeatmapCell[];
  width?: number;
  height?: number;
  columns?: number;
}

function interpolateColor(value: number, max: number): string {
  const ratio = max > 0 ? Math.min(value / max, 1) : 0;
  // Green (low) → Yellow (mid) → Red (high)
  if (ratio < 0.5) {
    const r = Math.round(255 * ratio * 2);
    return `rgb(${r}, 200, 100)`;
  }
  const g = Math.round(200 * (1 - (ratio - 0.5) * 2));
  return `rgb(255, ${g}, 80)`;
}

export function Heatmap({ data, width = 500, height = 300, columns = 5 }: HeatmapProps) {
  if (data.length === 0) return <svg width={width} height={height} />;

  const rows = Math.ceil(data.length / columns);
  const cellW = width / columns;
  const cellH = height / rows;
  const maxVal = Math.max(...data.map((d) => d.value), 1);

  return (
    <svg width={width} height={height} role="img" aria-label="Heatmap">
      {data.map((cell, i) => {
        const col = i % columns;
        const row = Math.floor(i / columns);
        const x = col * cellW;
        const y = row * cellH;
        const color = interpolateColor(cell.value, maxVal);

        return (
          <g key={cell.label}>
            <rect x={x} y={y} width={cellW - 2} height={cellH - 2} fill={color} rx={3} />
            <text
              x={x + cellW / 2}
              y={y + cellH / 2 - 6}
              textAnchor="middle"
              fontSize={9}
              fill="#0f172a"
            >
              {cell.label.length > 12 ? `${cell.label.slice(0, 12)}...` : cell.label}
            </text>
            <text
              x={x + cellW / 2}
              y={y + cellH / 2 + 8}
              textAnchor="middle"
              fontSize={10}
              fontWeight={600}
              fill="#0f172a"
            >
              {cell.value.toFixed(1)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
