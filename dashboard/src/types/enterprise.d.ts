/**
 * Ambient type declarations for the optional @ai-sdlc-enterprise/dashboard package.
 * When installed, the package provides its own types; this declaration prevents
 * TypeScript errors when the package is absent.
 */

declare module '@ai-sdlc-enterprise/dashboard' {
  import type { ComponentType } from 'react';
  import type { Database } from 'better-sqlite3';

  interface PageProps {
    db: Database;
  }

  export const TrendAnalysisPage: ComponentType<PageProps>;
  export const CostOptimizationPage: ComponentType<PageProps>;
  export const RoiDashboardPage: ComponentType<PageProps>;

  export function handleTrendsRequest(db: Database): Response | Promise<Response>;
  export function handleCostOptimizationRequest(db: Database): Response | Promise<Response>;
  export function handleRoiRequest(db: Database): Response | Promise<Response>;
}

declare module '@ai-sdlc-enterprise/dashboard/nav' {
  import type { NavItem } from '@/lib/nav-items';

  export const enterpriseNavItems: NavItem[];
}
