/**
 * Filter 1 — Dependency readiness (RFC-0015 §4.3 / Phase 3).
 *
 * Wraps the existing `cli-deps blockers <id>` query (`blockers()` from
 * `deps/dependency-graph.ts`) so the orchestrator can run it inline without
 * a subprocess. A candidate clears the filter when EVERY upstream task is
 * Done (or Cancelled — `frontier()` already encodes that semantics by only
 * counting `status === 'completed'` nodes).
 *
 * In production the orchestrator always sources candidates from `frontier()`
 * which means this filter is normally a no-op (every candidate already has
 * an empty blockers list by construction). The filter exists anyway as
 * defense-in-depth for two cases:
 *
 *   1. A future dispatcher that pulls from a non-frontier source (the Phase 4
 *      dashboard's "manual dispatch" surface, RFC-0014's "force-dispatch"
 *      override, etc.) — those callers are NOT bound by `frontier()` and
 *      need the same readiness check.
 *   2. A race where the graph file mtime updates between `frontier()` and
 *      the filter call (a sibling worker just shipped an upstream task).
 *      The filter re-checks against fresh graph state, catching the rare
 *      "candidate became stale mid-tick" case.
 *
 * @module orchestrator/filters/dependency-readiness
 */

import { blockers, type DependencyGraph } from '../../deps/dependency-graph.js';
import type { FilterResult } from './types.js';

export interface CheckDependencyReadinessOpts {
  /**
   * Pre-built graph. Sharing one graph across filters in the same tick keeps
   * file reads bounded — the loop builds it once and passes it to every
   * filter call.
   */
  graph: DependencyGraph;
  taskId: string;
}

/**
 * Walk the candidate's transitive forward-edge closure and reject the
 * candidate if any upstream task is still open.
 *
 * Pure — no I/O, no side effects. The graph + task ID come from the caller.
 */
export function checkDependencyReadiness(opts: CheckDependencyReadinessOpts): FilterResult {
  const open = blockers(opts.graph, opts.taskId);
  if (open.length === 0) {
    return { filter: 'DependencyReadiness', passed: true };
  }
  // `blockers()` already returns IDs in ascending numeric order; lowercase
  // them for the event payload so consumers can compare against
  // graph.openIds without case-folding.
  const blockerIds = open.map((n) => n.id.toLowerCase());
  return {
    filter: 'DependencyReadiness',
    passed: false,
    reason: `${blockerIds.length} blocker(s) still open: ${blockerIds.slice(0, 5).join(', ')}`,
    detail: { kind: 'dependency-blocked', blockers: blockerIds },
  };
}
