import { describe, it, expect, beforeEach } from 'vitest';
import { coreNavItems, getNavItems, type NavItem } from './nav-items';

describe('nav-items', () => {
  // Reset the module cache between tests so _cachedItems is cleared
  beforeEach(async () => {
    // Re-import to reset module state by invalidating the cache
    // The simplest approach: just test the exported values
  });

  describe('coreNavItems', () => {
    it('has 5 core navigation items', () => {
      expect(coreNavItems).toHaveLength(5);
    });

    it('includes Overview as the first item', () => {
      expect(coreNavItems[0]).toEqual({ href: '/', label: 'Overview' });
    });

    it('includes Cost, Autonomy, Codebase, and Audit', () => {
      const labels = coreNavItems.map((item) => item.label);
      expect(labels).toContain('Cost');
      expect(labels).toContain('Autonomy');
      expect(labels).toContain('Codebase');
      expect(labels).toContain('Audit');
    });

    it('all items have href and label', () => {
      for (const item of coreNavItems) {
        expect(item.href).toBeTruthy();
        expect(item.label).toBeTruthy();
      }
    });

    it('all hrefs start with /', () => {
      for (const item of coreNavItems) {
        expect(item.href.startsWith('/')).toBe(true);
      }
    });
  });

  describe('getNavItems', () => {
    it('returns at least the core nav items', async () => {
      const items = await getNavItems();
      expect(items.length).toBeGreaterThanOrEqual(coreNavItems.length);
      // All core items should be in the result
      for (const core of coreNavItems) {
        const found = items.find((i: NavItem) => i.href === core.href && i.label === core.label);
        expect(found).toBeTruthy();
      }
    });

    it('caches results on subsequent calls', async () => {
      const items1 = await getNavItems();
      const items2 = await getNavItems();
      // Should be the exact same reference (cached)
      expect(items1).toBe(items2);
    });
  });
});
