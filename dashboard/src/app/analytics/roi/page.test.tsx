import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/state', () => ({
  getStateStore: () => ({
    getDatabase: () => ({}),
  }),
}));

describe('RoiPage', () => {
  it('renders fallback when enterprise package is not installed', async () => {
    const { default: RoiPage } = await import('./page');
    const result = await RoiPage();
    expect(result).toBeTruthy();
    expect(result.type).toBe('div');
    const h1 = result.props.children[0];
    expect(h1.props.children).toBe('ROI Dashboard');
  });
});
