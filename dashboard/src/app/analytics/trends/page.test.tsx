import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/state', () => ({
  getStateStore: () => ({
    getDatabase: () => ({}),
  }),
}));

describe('TrendAnalysisPage', () => {
  it('renders fallback when enterprise package is not installed', async () => {
    const { default: TrendAnalysisPage } = await import('./page');
    const result = await TrendAnalysisPage();
    expect(result).toBeTruthy();
    expect(result.type).toBe('div');
    const h1 = result.props.children[0];
    expect(h1.props.children).toBe('Trend Analysis');
  });
});
