/**
 * Filter — Orphan-parent detection (AISDLC-175).
 *
 * Catches parent tasks whose every declared child landed in
 * `backlog/completed/`. The witness was a 2026-05-04 dogfood run of
 * `cli-orchestrator tick` that picked up AISDLC-70 (RFC-0010 parent task with
 * all 9 sub-tasks already in `backlog/completed/`). The dev subagent did the
 * right semantic thing — drafted a closure commit moving the parent file —
 * but this is bookkeeping work, not real dispatch. Worse, the closure had
 * already shipped via PR #231, so the dispatch was a complete duplicate.
 *
 * Detection
 * =========
 * A candidate X is an "orphan parent" iff:
 *   1. ≥1 OTHER task Y in the graph carries `parent_task_id: X` (any case),
 *      AND
 *   2. EVERY such child Y has `status === 'completed'` (file is in
 *      `backlog/completed/`, OR file is in `backlog/tasks/` but frontmatter
 *      already says `Done` — the same reclassification rule the rest of the
 *      graph uses per AISDLC-153).
 *
 * Not-an-orphan-parent cases (admitted):
 *   - Candidate has no declared children at all (it's a leaf or a top-level
 *     task without a phased breakdown — could be real work).
 *   - Candidate has children, but ≥1 is still open.
 *   - Candidate itself carries a non-empty `parent_task_id` (it's a child,
 *     not a parent — even if it has its own grandchildren, the orchestrator
 *     should still admit it because the candidate IS real work).
 *
 * The "candidate is itself a child" exclusion is important for nested
 * decompositions (AISDLC-100.7 has children of its own conceptually, but
 * it's also AISDLC-100's child — the orchestrator should keep working on
 * it, not refuse to dispatch).
 *
 * Pure: reads ONLY the pre-built graph. No I/O, no side effects.
 *
 * Cost: O(N) where N = total nodes in the graph. We could pre-build a
 * `parentId → childIds[]` reverse-index in `buildDependencyGraph` and turn
 * this into O(K) where K = candidate's child count, but graphs of even very
 * large backlogs (1000+ tasks) walk in microseconds and the simpler
 * implementation reads better. Phase 4 / future RFCs can add the index if
 * the corpus shows the linear walk dominates orchestrator hot-loop time.
 *
 * @module orchestrator/filters/orphan-parent
 */

import type { DependencyGraph, DependencyNode } from '../../deps/dependency-graph.js';
import type { FilterResult } from './types.js';

export interface CheckOrphanParentOpts {
  /** Pre-built graph — shared across all filters in this tick. */
  graph: DependencyGraph;
  /** Candidate task ID (case-insensitive lookup). */
  taskId: string;
}

/**
 * Walk the graph to find children of the candidate; reject the candidate
 * when it has children AND every child is already completed.
 *
 * Two short-circuit rejections of "this candidate is not an orphan parent":
 *   - If the candidate itself carries `parent_task_id`, it's a child (could
 *     be a leaf grandchild, could be a mid-tree node — either way the
 *     orchestrator should still consider it real work).
 *   - If no other task in the graph names the candidate as `parent_task_id`,
 *     it's not a parent at all.
 *
 * Pure — no I/O. The graph + task ID come from the caller.
 */
export function checkOrphanParent(opts: CheckOrphanParentOpts): FilterResult {
  const candidateKey = opts.taskId.toLowerCase();
  const candidate: DependencyNode | undefined = opts.graph.nodes.get(candidateKey);

  // Defensive: missing-from-graph candidate cannot be classified as an
  // orphan parent (no children to check). The dependency-readiness filter
  // applies the same "missing node = pass" defense; matching here keeps
  // the chain consistent.
  if (!candidate) {
    return { filter: 'OrphanParent', passed: true };
  }

  // The candidate is itself someone's child — not an orphan-parent
  // candidate, even if it has its own grandchildren. Closing a sub-task
  // is real dispatch work.
  if (candidate.parentTaskId.trim() !== '') {
    return { filter: 'OrphanParent', passed: true };
  }

  // Walk the full node map looking for children that name this candidate
  // as their `parent_task_id`. Case-insensitive comparison: the on-disk
  // frontmatter sometimes uses `AISDLC-70`, sometimes `aisdlc-70` — both
  // refer to the same parent.
  const completedChildren: string[] = [];
  let hasOpenChild = false;
  for (const child of opts.graph.nodes.values()) {
    if (child.parentTaskId.trim() === '') continue;
    if (child.parentTaskId.trim().toLowerCase() !== candidateKey) continue;
    // Don't count the candidate as its own child even in pathological
    // self-reference cases.
    if (child.id.toLowerCase() === candidateKey) continue;
    if (child.status === 'completed') {
      completedChildren.push(child.id.toLowerCase());
    } else {
      // First open child seen → no longer a closure candidate. We can
      // bail early because the rejection condition requires ALL children
      // to be completed.
      hasOpenChild = true;
      break;
    }
  }

  // No declared children → this candidate is not a parent at all (could be
  // a top-level task without a phased breakdown; the chain admits it and
  // lets downstream filters decide).
  if (!hasOpenChild && completedChildren.length === 0) {
    return { filter: 'OrphanParent', passed: true };
  }

  // Mixed children (≥1 open) → still real work. Admit and let the regular
  // chain run.
  if (hasOpenChild) {
    return { filter: 'OrphanParent', passed: true };
  }

  // All declared children are completed → orphan parent. Reject so the
  // orchestrator skips it; operators close the parent manually (or via a
  // future automatic-close affordance) per the AISDLC-175 design.
  completedChildren.sort();
  return {
    filter: 'OrphanParent',
    passed: false,
    reason: `orphan-parent-needs-closure (${completedChildren.length} completed child(ren), no open: ${completedChildren.slice(0, 5).join(', ')})`,
    detail: { kind: 'orphan-parent-needs-closure', completedChildren },
  };
}
