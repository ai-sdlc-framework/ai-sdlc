import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/nav-items', () => ({
  coreNavItems: [
    { href: '/', label: 'Overview' },
    { href: '/cost', label: 'Cost' },
  ],
  getNavItems: vi.fn().mockResolvedValue([
    { href: '/', label: 'Overview' },
    { href: '/cost', label: 'Cost' },
    { href: '/analytics/roi', label: 'ROI', section: 'Analytics' },
  ]),
}));

describe('RootLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders layout with children', async () => {
    const { default: RootLayout } = await import('./layout');
    const children = { type: 'div', props: { children: 'content' } };
    const result = RootLayout({ children: children as unknown as React.ReactNode });
    expect(result).toBeTruthy();
    expect(result.type).toBe('html');
  });

  it('has proper html structure', async () => {
    const { default: RootLayout } = await import('./layout');
    const result = RootLayout({ children: 'test' as unknown as React.ReactNode });
    // html > body > div with flex
    expect(result.type).toBe('html');
    expect(result.props.lang).toBe('en');
    const body = result.props.children;
    expect(body.type).toBe('body');
    const container = body.props.children;
    expect(container.props.style.display).toBe('flex');
  });
});
