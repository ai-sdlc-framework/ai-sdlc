/**
 * Impact analyzer — traces changed files to affected downstream services.
 *
 * Given a set of changed files and a ServiceMap, determines which services
 * are directly affected (contain changed files) and which are transitively
 * affected (depend on directly affected services).
 */

import { relative, normalize } from 'node:path';
import type { ServiceMap, ImpactResult } from './types.js';
import { getTransitiveDependents } from './service-map-builder.js';

/**
 * Analyze the impact of changed files across a service map.
 */
export function analyzeImpact(serviceMap: ServiceMap, changedFiles: string[]): ImpactResult {
  const directlyAffected = new Set<string>();

  // Normalize changed files to relative paths from root
  const normalizedFiles = changedFiles.map((f) => {
    if (f.startsWith('/') || f.startsWith(serviceMap.rootPath)) {
      return normalize(relative(serviceMap.rootPath, f));
    }
    return normalize(f);
  });

  // Find directly affected services (contain changed files)
  for (const file of normalizedFiles) {
    for (const service of serviceMap.services) {
      const serviceRelPath = normalize(relative(serviceMap.rootPath, service.path));
      if (file.startsWith(serviceRelPath + '/') || file === serviceRelPath) {
        directlyAffected.add(service.name);
      }
    }
  }

  // Find transitively affected services
  const transitivelyAffected = new Set<string>();
  for (const name of directlyAffected) {
    const transitive = getTransitiveDependents(serviceMap, name);
    for (const t of transitive) {
      if (!directlyAffected.has(t)) {
        transitivelyAffected.add(t);
      }
    }
  }

  const allAffected = new Set([...directlyAffected, ...transitivelyAffected]);
  const unaffected = serviceMap.services
    .map((s) => s.name)
    .filter((name) => !allAffected.has(name));

  return {
    changedFiles,
    directlyAffected: [...directlyAffected],
    transitivelyAffected: [...transitivelyAffected],
    allAffected: [...allAffected],
    unaffected,
  };
}

/**
 * Get a summary of the impact for logging or notification.
 */
export function formatImpactSummary(impact: ImpactResult): string {
  const lines: string[] = [];

  if (impact.directlyAffected.length > 0) {
    lines.push(`Directly affected: ${impact.directlyAffected.join(', ')}`);
  }
  if (impact.transitivelyAffected.length > 0) {
    lines.push(`Transitively affected: ${impact.transitivelyAffected.join(', ')}`);
  }
  if (impact.unaffected.length > 0) {
    lines.push(`Unaffected: ${impact.unaffected.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Determine the recommended build order for affected services.
 * Returns services in dependency order (leaf dependencies first).
 */
export function getAffectedBuildOrder(serviceMap: ServiceMap, impact: ImpactResult): string[] {
  const affected = new Set(impact.allAffected);
  const result: string[] = [];
  const visited = new Set<string>();

  const adjacency = new Map<string, string[]>();
  for (const node of serviceMap.services) {
    adjacency.set(
      node.name,
      node.dependencies.filter((d) => affected.has(d)),
    );
  }

  function visit(name: string): void {
    if (visited.has(name) || !affected.has(name)) return;
    visited.add(name);
    for (const dep of adjacency.get(name) ?? []) {
      visit(dep);
    }
    result.push(name);
  }

  for (const name of affected) {
    visit(name);
  }

  return result;
}
