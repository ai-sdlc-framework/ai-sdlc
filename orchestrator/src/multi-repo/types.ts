/**
 * Types for multi-repo/monorepo orchestration.
 */

export interface ServiceNode {
  name: string;
  path: string;
  /** Package manager or build system. */
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'go' | 'cargo' | 'unknown';
  /** Direct dependencies on other services in the workspace. */
  dependencies: string[];
  /** Services that depend on this one. */
  dependents: string[];
  /** Version from package.json or equivalent. */
  version?: string;
}

export interface ServiceMap {
  services: ServiceNode[];
  /** Dependency edges between services. */
  edges: ServiceEdge[];
  /** Root directory of the workspace. */
  rootPath: string;
  /** Detected layout type. */
  layout: MonorepoLayout;
}

export interface ServiceEdge {
  from: string;
  to: string;
  /** Type of dependency. */
  type: 'workspace' | 'external' | 'dev';
}

export type MonorepoLayout =
  | 'pnpm-workspace'
  | 'npm-workspaces'
  | 'yarn-workspaces'
  | 'go-workspace'
  | 'cargo-workspace'
  | 'single-repo';

export interface WorkspaceConfig {
  layout: MonorepoLayout;
  rootPath: string;
  packages: WorkspacePackage[];
}

export interface WorkspacePackage {
  name: string;
  path: string;
  relativePath: string;
}

export interface ImpactResult {
  /** Changed files that triggered the analysis. */
  changedFiles: string[];
  /** Directly affected services (contain changed files). */
  directlyAffected: string[];
  /** Transitively affected downstream services. */
  transitivelyAffected: string[];
  /** All affected services (union of direct + transitive). */
  allAffected: string[];
  /** Services that are safe / not affected. */
  unaffected: string[];
}
