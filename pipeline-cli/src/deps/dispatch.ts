/**
 * RFC-0014 Phase 2 — depth-aware dispatcher comparator.
 *
 * Wraps the existing `frontier()` query (AISDLC-117) with a sort that prefers
 * tasks on the critical path. Strictly read-only: nothing here mutates the
 * graph or the calibration log; we only re-order the same frontier the
 * baseline returned.
 *
 * The dispatcher is the consumer of `cli-deps frontier` — when an operator
 * runs `cli-deps frontier --format table` (or `/ai-sdlc execute` consults
 * the same query) the FIRST entry is the next task to dispatch. Phase 2
 * changes which entry is first; it does not gate, filter, or hide anything.
 *
 * Sort order per RFC-0014 §12 Q1:
 *
 *   effectivePriority DESC → criticalPathLength DESC → recency DESC → id ASC
 *
 * Recency = task file mtime (ISO-8601 string, lexically sortable). The final
 * `id ASC` tiebreak keeps the order deterministic when every other field is
 * equal — useful for snapshot tests + reproducible operator output.
 *
 * Behind feature flag `AI_SDLC_DEPS_COMPOSITION` (RFC-0014 §9). When OFF the
 * comparator is a pass-through: the frontier returns in baseline order
 * (`id ASC` from `frontier()`). When ON the depth-aware sort applies. This
 * lets us soak Phase 2 against operator behaviour before promoting in Phase 5.
 *
 * @module deps/dispatch
 */

import type { DependencyGraph, FrontierEntry } from './dependency-graph.js';
import {
  computeEffectivePriorities,
  type EffectivePriorityRecord,
  type ComputeEffectivePrioritiesOpts,
} from './effective-priority.js';
import { isCompositionEnabled } from './snapshot.js';

export interface SortFrontierOpts extends ComputeEffectivePrioritiesOpts {
  /**
   * Force the depth-aware sort regardless of the env flag. Used by tests +
   * the future Phase 5 promotion ramp where we want to A/B compare the two
   * orderings within the same process.
   */
  forceComposition?: boolean;
  /**
   * Force the baseline (id-ASC) sort regardless of the env flag. Same A/B
   * intent as `forceComposition`; both flags being set is undefined behaviour
   * (we let `forceComposition` win).
   */
  forceBaseline?: boolean;
}

export interface RankedFrontierEntry extends FrontierEntry {
  /** Numeric priority weight read from this task's frontmatter. */
  basePriority: number;
  /**
   * `max(basePriority, max basePriority across transitive downstream(T))`.
   * Equal to `basePriority` for leaves with no downstream (they don't inherit
   * anything). Always `>= basePriority`.
   */
  effectivePriority: number;
  /** Longest forward chain length from T (RFC-0014 §12 Q1 secondary tiebreak). */
  criticalPathLength: number;
  /** ISO-8601 file mtime, used as the tertiary tiebreak. */
  lastModified: string;
}

/**
 * Sort the frontier by `effectivePriority DESC → criticalPathLength DESC →
 * recency DESC → id ASC` per RFC-0014 §12 Q1, behind the
 * `AI_SDLC_DEPS_COMPOSITION` feature flag.
 *
 * When the flag is OFF the input frontier is returned as-is (baseline order
 * from `frontier()`, which is `id ASC`). When the flag is ON the comparator
 * recomputes effective priorities for every node in the graph and ranks the
 * frontier by them.
 *
 * Pure function — reads from `process.env` exactly once (via
 * `isCompositionEnabled`) and otherwise does not touch global state. Always
 * returns a NEW array; never mutates the input.
 *
 * @param graph    the in-memory dependency graph (caller already built it)
 * @param frontier the baseline frontier from `frontier(graph)` — already
 *                 filtered to ready-to-dispatch tasks
 * @param opts     resolver overrides + force flags
 * @returns        the frontier in dispatch order, with effective-priority
 *                 metadata attached so callers can render rationale
 */
export function sortFrontierByEffectivePriority(
  graph: DependencyGraph,
  frontier: FrontierEntry[],
  opts: SortFrontierOpts = {},
): RankedFrontierEntry[] {
  const enabled =
    opts.forceComposition === true
      ? true
      : opts.forceBaseline === true
        ? false
        : isCompositionEnabled();

  // Always compute the priority records so callers can introspect them in
  // both modes (e.g. dashboard rendering, soak A/B comparison). The cost is
  // O(V + E), well below the per-dispatch budget per RFC-0014 §12 Q4.
  const records = computeEffectivePriorities(graph, opts);

  const ranked: RankedFrontierEntry[] = frontier.map((entry) => {
    const record = records.get(entry.id.toLowerCase());
    return {
      ...entry,
      basePriority: record?.basePriority ?? 0,
      effectivePriority: record?.effectivePriority ?? 0,
      criticalPathLength: record?.criticalPathLength ?? 0,
      lastModified: record?.lastModified ?? '',
    };
  });

  if (!enabled) {
    // Baseline mode: preserve the order `frontier()` already returned.
    // `frontier()` already sorts by id ASC so we just pass through.
    return ranked;
  }

  ranked.sort(compareForDispatch);
  return ranked;
}

/**
 * Per RFC-0014 §12 Q1 sort order. Exposed for unit tests + future callers
 * that want to apply the same comparator to a non-frontier list (e.g. a
 * "next 5 critical-path items" digest in Phase 4).
 */
export function compareForDispatch(a: RankedFrontierEntry, b: RankedFrontierEntry): number {
  // Primary: effectivePriority DESC.
  if (a.effectivePriority !== b.effectivePriority) {
    return b.effectivePriority - a.effectivePriority;
  }
  // Secondary: criticalPathLength DESC. Structural signal (chain depth)
  // dominates arbitrary signal (recency) when effective priority ties.
  if (a.criticalPathLength !== b.criticalPathLength) {
    return b.criticalPathLength - a.criticalPathLength;
  }
  // Tertiary: recency DESC (newer file wins). ISO-8601 strings are
  // lexically sortable; empty strings sort to the bottom (older).
  if (a.lastModified !== b.lastModified) {
    return b.lastModified.localeCompare(a.lastModified);
  }
  // Final: id ASC for deterministic snapshot/test output.
  return a.id.localeCompare(b.id, 'en', { numeric: true });
}

/**
 * Compute a single `effectivePriority` record set + return it sorted by
 * dispatch order. Convenience helper for callers that don't have a baseline
 * frontier to start from (e.g. the future Phase 4 dashboard, which renders
 * the WHOLE open graph not just the ready frontier).
 *
 * Honours the feature flag the same way as `sortFrontierByEffectivePriority`.
 */
export function rankAllByEffectivePriority(
  graph: DependencyGraph,
  opts: SortFrontierOpts = {},
): EffectivePriorityRecord[] {
  const enabled =
    opts.forceComposition === true
      ? true
      : opts.forceBaseline === true
        ? false
        : isCompositionEnabled();
  const records = Array.from(computeEffectivePriorities(graph, opts).values());
  if (!enabled) {
    records.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
    return records;
  }
  records.sort((a, b) => {
    if (a.effectivePriority !== b.effectivePriority)
      return b.effectivePriority - a.effectivePriority;
    if (a.criticalPathLength !== b.criticalPathLength)
      return b.criticalPathLength - a.criticalPathLength;
    if (a.lastModified !== b.lastModified) return b.lastModified.localeCompare(a.lastModified);
    return a.id.localeCompare(b.id, 'en', { numeric: true });
  });
  return records;
}
