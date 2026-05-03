/**
 * Deps barrel — re-exports the dependency graph builder + queries so the
 * CLI router and library consumers can import from one place.
 */
export * from './dependency-graph.js';
export * from './snapshot.js';
export * from './effective-priority.js';
export * from './dispatch.js';
export * from './critical-path.js';
