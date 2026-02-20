/**
 * Inline SVG sparkline component.
 */

interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}

export function Sparkline({ values, width = 80, height = 24, color = '#3b82f6' }: SparklineProps) {
  if (values.length < 2) return <svg width={width} height={height} />;

  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${i * step},${height - (v / max) * height}`).join(' ');

  return (
    <svg width={width} height={height} role="img" aria-label="Sparkline">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
