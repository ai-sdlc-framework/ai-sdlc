/**
 * Service map builder — constructs a dependency graph from workspace packages.
 *
 * Reads package.json (or go.mod/Cargo.toml) to discover inter-package
 * dependencies and builds a ServiceMap graph.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ServiceNode,
  ServiceMap,
  ServiceEdge,
  WorkspaceConfig,
  WorkspacePackage,
} from './types.js';

/**
 * Build a service dependency graph from a workspace configuration.
 */
export function buildServiceMap(config: WorkspaceConfig): ServiceMap {
  const packageNames = new Set(config.packages.map((p) => p.name));
  const nodes: ServiceNode[] = [];
  const edges: ServiceEdge[] = [];
  const dependentsMap = new Map<string, string[]>();

  // Initialize dependents map
  for (const pkg of config.packages) {
    dependentsMap.set(pkg.name, []);
  }

  // Build nodes and discover edges
  for (const pkg of config.packages) {
    const deps = discoverDependencies(pkg, config.layout, packageNames);
    const node: ServiceNode = {
      name: pkg.name,
      path: pkg.path,
      packageManager: layoutToPackageManager(config.layout),
      dependencies: deps.map((d) => d.to),
      dependents: [], // Filled in after all edges discovered
      version: readVersion(pkg, config.layout),
    };
    nodes.push(node);

    for (const dep of deps) {
      edges.push(dep);
      const existing = dependentsMap.get(dep.to);
      if (existing) existing.push(dep.from);
    }
  }

  // Fill in dependents
  for (const node of nodes) {
    node.dependents = dependentsMap.get(node.name) ?? [];
  }

  return {
    services: nodes,
    edges,
    rootPath: config.rootPath,
    layout: config.layout,
  };
}

/**
 * Detect cycles in a service map. Returns arrays of service names forming cycles.
 */
export function detectCycles(serviceMap: ServiceMap): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const pathStack: string[] = [];

  const adjacency = new Map<string, string[]>();
  for (const node of serviceMap.services) {
    adjacency.set(node.name, node.dependencies);
  }

  function dfs(name: string): void {
    visited.add(name);
    recursionStack.add(name);
    pathStack.push(name);

    for (const dep of adjacency.get(name) ?? []) {
      if (!visited.has(dep)) {
        dfs(dep);
      } else if (recursionStack.has(dep)) {
        // Found a cycle
        const cycleStart = pathStack.indexOf(dep);
        if (cycleStart >= 0) {
          cycles.push([...pathStack.slice(cycleStart), dep]);
        }
      }
    }

    pathStack.pop();
    recursionStack.delete(name);
  }

  for (const node of serviceMap.services) {
    if (!visited.has(node.name)) {
      dfs(node.name);
    }
  }

  return cycles;
}

/**
 * Get topologically sorted service names (leaf dependencies first).
 */
export function topologicalOrder(serviceMap: ServiceMap): string[] {
  const sorted: string[] = [];
  const visited = new Set<string>();

  const adjacency = new Map<string, string[]>();
  for (const node of serviceMap.services) {
    adjacency.set(node.name, node.dependencies);
  }

  function visit(name: string): void {
    if (visited.has(name)) return;
    visited.add(name);
    for (const dep of adjacency.get(name) ?? []) {
      visit(dep);
    }
    sorted.push(name);
  }

  for (const node of serviceMap.services) {
    visit(node.name);
  }

  return sorted;
}

/**
 * Get all transitive dependents of a service (downstream consumers).
 */
export function getTransitiveDependents(serviceMap: ServiceMap, serviceName: string): string[] {
  const result = new Set<string>();
  const queue = [serviceName];

  const dependentsMap = new Map<string, string[]>();
  for (const node of serviceMap.services) {
    dependentsMap.set(node.name, node.dependents);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependent of dependentsMap.get(current) ?? []) {
      if (!result.has(dependent)) {
        result.add(dependent);
        queue.push(dependent);
      }
    }
  }

  return [...result];
}

// ── Internal ──────────────────────────────────────────────────────────

function discoverDependencies(
  pkg: WorkspacePackage,
  layout: string,
  workspaceNames: Set<string>,
): ServiceEdge[] {
  const edges: ServiceEdge[] = [];

  if (layout === 'go-workspace') {
    return discoverGoDependencies(pkg, workspaceNames);
  }

  if (layout === 'cargo-workspace') {
    return discoverCargoDependencies(pkg, workspaceNames);
  }

  // npm/pnpm/yarn: read package.json
  const pkgJsonPath = join(pkg.path, 'package.json');
  if (!existsSync(pkgJsonPath)) return edges;

  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    const allDeps = {
      ...pkgJson.dependencies,
      ...pkgJson.peerDependencies,
    };
    const devDeps = pkgJson.devDependencies ?? {};

    for (const [dep] of Object.entries(allDeps)) {
      if (workspaceNames.has(dep)) {
        edges.push({ from: pkg.name, to: dep, type: 'workspace' });
      }
    }

    for (const [dep] of Object.entries(devDeps)) {
      if (workspaceNames.has(dep)) {
        edges.push({ from: pkg.name, to: dep, type: 'dev' });
      }
    }
  } catch {
    /* ignore bad JSON */
  }

  return edges;
}

function discoverGoDependencies(pkg: WorkspacePackage, workspaceNames: Set<string>): ServiceEdge[] {
  const edges: ServiceEdge[] = [];
  const goModPath = join(pkg.path, 'go.mod');
  if (!existsSync(goModPath)) return edges;

  try {
    const content = readFileSync(goModPath, 'utf-8');
    for (const name of workspaceNames) {
      if (name !== pkg.name && content.includes(name)) {
        edges.push({ from: pkg.name, to: name, type: 'workspace' });
      }
    }
  } catch {
    /* ignore */
  }

  return edges;
}

function discoverCargoDependencies(
  pkg: WorkspacePackage,
  workspaceNames: Set<string>,
): ServiceEdge[] {
  const edges: ServiceEdge[] = [];
  const cargoPath = join(pkg.path, 'Cargo.toml');
  if (!existsSync(cargoPath)) return edges;

  try {
    const content = readFileSync(cargoPath, 'utf-8');
    for (const name of workspaceNames) {
      if (name !== pkg.name && content.includes(`path = `) && content.includes(name)) {
        edges.push({ from: pkg.name, to: name, type: 'workspace' });
      }
    }
  } catch {
    /* ignore */
  }

  return edges;
}

function layoutToPackageManager(layout: string): ServiceNode['packageManager'] {
  switch (layout) {
    case 'pnpm-workspace':
      return 'pnpm';
    case 'npm-workspaces':
      return 'npm';
    case 'yarn-workspaces':
      return 'yarn';
    case 'go-workspace':
      return 'go';
    case 'cargo-workspace':
      return 'cargo';
    default:
      return 'unknown';
  }
}

function readVersion(pkg: WorkspacePackage, layout: string): string | undefined {
  if (layout === 'go-workspace' || layout === 'cargo-workspace') return undefined;

  const pkgJsonPath = join(pkg.path, 'package.json');
  if (!existsSync(pkgJsonPath)) return undefined;

  try {
    return JSON.parse(readFileSync(pkgJsonPath, 'utf-8')).version;
  } catch {
    return undefined;
  }
}
