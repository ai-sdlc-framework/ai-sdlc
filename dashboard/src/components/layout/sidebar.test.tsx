import { describe, it, expect } from 'vitest';
import { Sidebar } from './sidebar';

describe('Sidebar', () => {
  it('renders navigation element', () => {
    const result = Sidebar({ currentPath: '/' });
    expect(result).toBeTruthy();
    expect(result.type).toBe('nav');
  });

  it('renders title', () => {
    const result = Sidebar({ currentPath: '/' });
    const titleDiv = result.props.children[0];
    expect(titleDiv.props.children).toBe('AI-SDLC');
  });

  it('renders nav items as links', () => {
    const result = Sidebar({ currentPath: '/' });
    const ul = result.props.children[1];
    expect(ul.type).toBe('ul');
    // Should have 5 nav items
    expect(ul.props.children).toHaveLength(5);
  });

  it('highlights the current path', () => {
    const result = Sidebar({ currentPath: '/cost' });
    const ul = result.props.children[1];
    const costItem = ul.props.children.find(
      (li: { props: { children: { props: { href: string } } } }) =>
        li.props.children.props.href === '/cost',
    );
    expect(costItem).toBeTruthy();
    // Active item has blue background
    expect(costItem.props.children.props.style.backgroundColor).toBe('#eff6ff');
    expect(costItem.props.children.props.style.color).toBe('#1d4ed8');
  });

  it('does not highlight non-active paths', () => {
    const result = Sidebar({ currentPath: '/cost' });
    const ul = result.props.children[1];
    const overviewItem = ul.props.children.find(
      (li: { props: { children: { props: { href: string } } } }) =>
        li.props.children.props.href === '/',
    );
    expect(overviewItem.props.children.props.style.backgroundColor).toBe('transparent');
    expect(overviewItem.props.children.props.style.color).toBe('#475569');
  });
});
