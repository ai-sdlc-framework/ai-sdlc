/**
 * Navigation item registry.
 * Core items are always shown; enterprise items are merged when the package is available.
 */

export interface NavItem {
  href: string;
  label: string;
  section?: string;
}

export const coreNavItems: NavItem[] = [
  { href: '/', label: 'Overview' },
  { href: '/cost', label: 'Cost' },
  { href: '/autonomy', label: 'Autonomy' },
  { href: '/codebase', label: 'Codebase' },
  { href: '/audit', label: 'Audit' },
];

let _cachedItems: NavItem[] | null = null;

/**
 * Returns the full nav item list, including enterprise items if the package is installed.
 * Uses a simple cache to avoid repeated dynamic imports.
 */
export async function getNavItems(): Promise<NavItem[]> {
  if (_cachedItems) return _cachedItems;

  let enterpriseItems: NavItem[] = [];
  try {
    const mod = await import('@ai-sdlc-enterprise/dashboard/nav');
    enterpriseItems = mod.enterpriseNavItems ?? [];
  } catch {
    // Enterprise package not installed — that's fine
  }

  _cachedItems = [...coreNavItems, ...enterpriseItems];
  return _cachedItems;
}
