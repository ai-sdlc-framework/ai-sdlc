import { describe, it, expect } from 'vitest';
import { Heatmap, type HeatmapCell } from './heatmap';

describe('Heatmap', () => {
  it('renders empty SVG for no data', () => {
    const result = Heatmap({ data: [] });
    expect(result).toBeTruthy();
  });

  it('renders cells', () => {
    const data: HeatmapCell[] = [
      { label: 'file-a.ts', value: 5 },
      { label: 'file-b.ts', value: 10 },
      { label: 'file-c.ts', value: 3 },
    ];
    const result = Heatmap({ data });
    expect(result).toBeTruthy();
  });

  it('truncates long labels', () => {
    const data: HeatmapCell[] = [
      { label: 'very-long-file-name-that-exceeds-limit.ts', value: 7 },
    ];
    const result = Heatmap({ data });
    expect(result).toBeTruthy();
  });

  it('accepts custom grid', () => {
    const data: HeatmapCell[] = Array.from({ length: 12 }, (_, i) => ({
      label: `f${i}`,
      value: i * 2,
    }));
    const result = Heatmap({ data, columns: 4, width: 400, height: 300 });
    expect(result?.props?.width).toBe(400);
  });

  it('handles zero values', () => {
    const data: HeatmapCell[] = [{ label: 'zero', value: 0 }];
    const result = Heatmap({ data });
    expect(result).toBeTruthy();
  });
});
