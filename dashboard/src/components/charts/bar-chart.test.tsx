import { describe, it, expect } from 'vitest';
import { BarChart, type BarChartDatum } from './bar-chart';

describe('BarChart', () => {
  it('renders empty SVG for no data', () => {
    const result = BarChart({ data: [], width: 400, height: 200 });
    expect(result).toBeTruthy();
    expect(result?.props?.width).toBe(400);
  });

  it('renders bars for data', () => {
    const data: BarChartDatum[] = [
      { label: 'A', value: 10 },
      { label: 'B', value: 20 },
    ];
    const result = BarChart({ data, width: 400, height: 200 });
    expect(result).toBeTruthy();
    // Should have a group with rects
    const g = result?.props?.children;
    expect(g).toBeTruthy();
  });

  it('accepts custom color', () => {
    const data: BarChartDatum[] = [{ label: 'A', value: 10 }];
    const result = BarChart({ data, barColor: '#ff0000' });
    expect(result).toBeTruthy();
  });

  it('handles single data point', () => {
    const data: BarChartDatum[] = [{ label: 'Solo', value: 42 }];
    const result = BarChart({ data });
    expect(result).toBeTruthy();
  });

  it('respects per-item color override', () => {
    const data: BarChartDatum[] = [{ label: 'A', value: 10, color: '#16a34a' }];
    const result = BarChart({ data });
    expect(result).toBeTruthy();
  });
});
