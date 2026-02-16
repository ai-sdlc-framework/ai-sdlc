import { describe, it, expect } from 'vitest';
import { Sparkline } from './sparkline';

describe('Sparkline', () => {
  it('renders empty SVG for single value', () => {
    const result = Sparkline({ values: [5] });
    expect(result).toBeTruthy();
  });

  it('renders polyline for multiple values', () => {
    const result = Sparkline({ values: [1, 3, 2, 5, 4] });
    expect(result).toBeTruthy();
    expect(result?.props?.width).toBe(80);
  });

  it('accepts custom dimensions and color', () => {
    const result = Sparkline({ values: [1, 2, 3], width: 120, height: 32, color: '#f00' });
    expect(result?.props?.width).toBe(120);
    expect(result?.props?.height).toBe(32);
  });
});
