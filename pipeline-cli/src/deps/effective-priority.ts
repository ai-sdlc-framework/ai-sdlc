/**
 * RFC-0014 Phase 2 — depth-aware effective priority.
 *
 * Composes the dependency graph (AISDLC-117 / Phase 1) with the per-task
 * priority signal so the dispatcher can make decisions PPA cannot make
 * alone: a low-priority leaf that unblocks a critical chain inherits the
 * chain's urgency and bubbles to the top of the dispatch queue.
 *
 * Per RFC-0014 §5.2 + the AISDLC-167.2 task spec:
 *
 *     effectivePriority(T) = max(priority(T), max(priority(D) for D in downstream(T)))
 *
 * Where `downstream(T)` is the transitive closure of the reverse edge set
 * (every task that depends on T, directly or via a chain). The composition
 * is **read-only for PPA per §5.3** — the per-task `priority(T)` value is
 * unchanged in the calibration log; only the dispatcher's sort order is
 * affected by `effectivePriority`. The composition is also **monotonic**:
 * adding a new dependency edge can only INCREASE the effective priority of
 * upstream tasks, never decrease it (max-aggregation is idempotent).
 *
 * Per RFC-0014 §12 Q4 (no cache): every consumer recomputes per dispatch
 * decision. At current scale (~150 tasks, ~200 edges) DFS is sub-millisecond
 * and adding a TTL cache would invite invalidation bugs (stale cache → wrong
 * dispatch decision) for negative measured benefit.
 *
 * @module deps/effective-priority
 */

import type { DependencyGraph, DependencyNode } from './dependency-graph.js';

/**
 * Backlog.md `priority:` frontmatter values, lowercased + trimmed. The
 * dispatcher comparator only ever sees the numeric form via
 * {@link readPriority}; this enum exists to document the canonical set we
 * recognise and to keep the mapping table in one place.
 */
export const PRIORITY_BUCKETS = ['low', 'medium', 'high', 'critical'] as const;

export type PriorityBucket = (typeof PRIORITY_BUCKETS)[number];

/**
 * Numeric weight for each Backlog.md priority bucket. Higher = more urgent.
 *
 * These values are **dispatch-only**: they don't replace the PPA composite
 * score (RFC-0008) and they don't get written back into any task file. They
 * exist so the dispatcher comparator can rank tasks whose only available
 * priority signal is the Backlog.md frontmatter (every task has one — RFC
 * §5.2's `priority(T)` is whatever the system can read for T).
 *
 * Unknown / missing priorities default to `medium` (2) so a task without a
 * `priority:` field doesn't accidentally outrank or undercut its peers.
 */
export const PRIORITY_WEIGHT: Readonly<Record<PriorityBucket, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Default weight when the frontmatter `priority:` is absent or unrecognised. */
export const DEFAULT_PRIORITY_WEIGHT: number = PRIORITY_WEIGHT.medium;

/**
 * Read the numeric priority weight for a task. Defaults to reading
 * `node.priority` (populated by `parseTaskFrontmatter`); a custom
 * `priorityResolver` overrides that path so tests can drive the comparator
 * with synthetic values without writing to disk.
 *
 * Pure: inspects only the in-memory node; no disk reads. Returns
 * {@link DEFAULT_PRIORITY_WEIGHT} when the resolver returns nothing AND the
 * node carries no frontmatter priority.
 *
 * @internal Used by {@link computeEffectivePriorities}.
 */
export function priorityWeightFor(
  node: DependencyNode,
  priorityResolver?: (node: DependencyNode) => string | undefined,
): number {
  const raw = priorityResolver ? priorityResolver(node) : node.priority;
  return readPriorityWeight(raw);
}

/**
 * Map a free-form `priority:` string ("high", "Critical", " low ") to its
 * numeric weight. Unrecognised values fall back to {@link DEFAULT_PRIORITY_WEIGHT}.
 *
 * Exported so callers (tests, future Phase 4 dashboard renderers) can use the
 * same normalisation path without duplicating the lookup table.
 */
export function readPriorityWeight(raw: string | undefined | null): number {
  if (raw === undefined || raw === null) return DEFAULT_PRIORITY_WEIGHT;
  const key = String(raw).trim().toLowerCase();
  if (key === '') return DEFAULT_PRIORITY_WEIGHT;
  if (isPriorityBucket(key)) return PRIORITY_WEIGHT[key];
  return DEFAULT_PRIORITY_WEIGHT;
}

function isPriorityBucket(value: string): value is PriorityBucket {
  return (PRIORITY_BUCKETS as readonly string[]).includes(value);
}

/** One row per task — what the dispatcher comparator consumes. */
export interface EffectivePriorityRecord {
  /** Canonical task ID (case preserved from the file). */
  id: string;
  /** Numeric priority weight read from the task's frontmatter (1-4 with default 2). */
  basePriority: number;
  /**
   * `max(basePriority, max basePriority across transitive downstream(T))`.
   * Always `>= basePriority`. Per RFC-0014 §5.3 boundary contract this is a
   * MAX, not a sum — a 20-task chain doesn't get 20× boost.
   */
  effectivePriority: number;
  /**
   * Longest forward chain length from T (number of steps to the deepest leaf).
   * Mirrors the `criticalPathLength` field in the snapshot artifact; we
   * recompute it here so the comparator can use it as the secondary tiebreak
   * even when a snapshot isn't on disk yet (per RFC-0014 §12 Q4 no-cache).
   */
  criticalPathLength: number;
  /**
   * ISO-8601 file mtime, used as the tertiary tiebreak. Empty string for
   * nodes whose stat failed at graph-build time — those get sorted last
   * in the recency tie.
   */
  lastModified: string;
}

export interface ComputeEffectivePrioritiesOpts {
  /**
   * Resolver mapping a node to its raw `priority:` frontmatter value. Defaults
   * to a no-op (every node weights at {@link DEFAULT_PRIORITY_WEIGHT}). Tests
   * inject a custom resolver to drive the comparator without touching disk.
   *
   * In production the resolver is wired by the CLI (which has seen the task
   * file already) — see `cli/deps.ts`.
   */
  priorityResolver?: (node: DependencyNode) => string | undefined;
}

/**
 * Pure function — compute the effective-priority record set for every node in
 * the graph. Returns a `Map` keyed by lowercase ID for case-insensitive lookup
 * (matching `DependencyGraph.nodes`).
 *
 * Algorithm:
 *
 *  1. Walk forward edges (`node.dependencies`) once to build the reverse
 *     adjacency map (id → list of dependents).
 *  2. For each node compute `criticalPathLength` via memoised DFS over the
 *     reverse edges. Cycle-safe: a re-entry into a node already on the
 *     recursion stack short-circuits to 0 so a malformed graph still
 *     produces a finite answer (validate() flags the cycle separately).
 *  3. For each node compute `effectivePriority = max(basePriority, max over
 *     downstream(T) of basePriority)` via memoised DFS over the same reverse
 *     edges. Cycle-safe identically.
 *
 * Total complexity: O(V + E) for the reverse map + O(V + E) for each DFS,
 * memoised. Sub-millisecond at our scale per RFC-0014 §12 Q4.
 */
export function computeEffectivePriorities(
  graph: DependencyGraph,
  opts: ComputeEffectivePrioritiesOpts = {},
): Map<string, EffectivePriorityRecord> {
  // Reverse adjacency: id → list of dependent IDs (lowercase).
  const reverse = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    for (const dep of node.dependencies) {
      const key = dep.toLowerCase();
      const arr = reverse.get(key) ?? [];
      arr.push(node.id.toLowerCase());
      reverse.set(key, arr);
    }
  }

  // Per-node base priority cache so we don't re-resolve the same node twice
  // across the two DFS passes.
  const basePriority = new Map<string, number>();
  for (const [key, node] of graph.nodes.entries()) {
    basePriority.set(key, priorityWeightFor(node, opts.priorityResolver));
  }

  const cplCache = new Map<string, number>();
  const effCache = new Map<string, number>();

  function cplOf(key: string, onStack: Set<string>): number {
    const cached = cplCache.get(key);
    if (cached !== undefined) return cached;
    if (onStack.has(key)) return 0; // cycle guard
    onStack.add(key);
    let best = 0;
    for (const childId of reverse.get(key) ?? []) {
      const childKey = childId.toLowerCase();
      if (!graph.nodes.has(childKey)) continue;
      const candidate = 1 + cplOf(childKey, onStack);
      if (candidate > best) best = candidate;
    }
    onStack.delete(key);
    cplCache.set(key, best);
    return best;
  }

  function effectiveOf(key: string, onStack: Set<string>): number {
    const cached = effCache.get(key);
    if (cached !== undefined) return cached;
    if (onStack.has(key)) {
      // Cycle: short-circuit to the base priority for this node so we don't
      // recurse forever. The cycle itself is reported separately by
      // validate(); here we just want to avoid stack overflow.
      return basePriority.get(key) ?? DEFAULT_PRIORITY_WEIGHT;
    }
    onStack.add(key);
    let best = basePriority.get(key) ?? DEFAULT_PRIORITY_WEIGHT;
    for (const childId of reverse.get(key) ?? []) {
      const childKey = childId.toLowerCase();
      if (!graph.nodes.has(childKey)) continue;
      const candidate = effectiveOf(childKey, onStack);
      if (candidate > best) best = candidate;
    }
    onStack.delete(key);
    effCache.set(key, best);
    return best;
  }

  const out = new Map<string, EffectivePriorityRecord>();
  for (const [key, node] of graph.nodes.entries()) {
    const base = basePriority.get(key) ?? DEFAULT_PRIORITY_WEIGHT;
    const eff = effectiveOf(key, new Set());
    const cpl = cplOf(key, new Set());
    out.set(key, {
      id: node.id,
      basePriority: base,
      effectivePriority: eff,
      criticalPathLength: cpl,
      lastModified: node.lastModified,
    });
  }
  return out;
}
