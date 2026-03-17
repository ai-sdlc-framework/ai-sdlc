import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/state', () => ({
  getStateStore: () => ({
    getDatabase: () => ({}),
  }),
}));

describe('CostOptimizationPage', () => {
  it('renders fallback when enterprise package is not installed', async () => {
    const { default: CostOptimizationPage } = await import('./page');
    const result = await CostOptimizationPage();
    expect(result).toBeTruthy();
    // Should render the fallback div with enterprise message
    expect(result.type).toBe('div');
    // Check that the h1 text is "Cost Optimization"
    const h1 = result.props.children[0];
    expect(h1.props.children).toBe('Cost Optimization');
  });
});
