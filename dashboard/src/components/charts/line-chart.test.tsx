import { describe, it, expect } from 'vitest';
import { LineChart, type LineChartDatum } from './line-chart';

describe('LineChart', () => {
  it('renders empty SVG for no data', () => {
    const result = LineChart({ data: [] });
    expect(result).toBeTruthy();
  });

  it('renders line for data', () => {
    const data: LineChartDatum[] = [
      { label: 'Jan', value: 5 },
      { label: 'Feb', value: 10 },
      { label: 'Mar', value: 7 },
    ];
    const result = LineChart({ data, width: 400, height: 200 });
    expect(result).toBeTruthy();
    expect(result?.props?.width).toBe(400);
  });

  it('handles single data point', () => {
    const data: LineChartDatum[] = [{ label: 'Solo', value: 42 }];
    const result = LineChart({ data });
    expect(result).toBeTruthy();
  });

  it('accepts custom colors', () => {
    const data: LineChartDatum[] = [
      { label: 'A', value: 1 },
      { label: 'B', value: 2 },
    ];
    const result = LineChart({ data, lineColor: '#ff0000', fillColor: '#ff000020' });
    expect(result).toBeTruthy();
  });
});
