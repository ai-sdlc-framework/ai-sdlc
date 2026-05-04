/**
 * Pre-dispatch filter types (RFC-0015 Phase 3 / AISDLC-169.3).
 *
 * Each filter answers ONE question against ONE candidate task and returns a
 * uniform `{passed, reason?, detail?}` shape. The chain composes filters in
 * the order RFC §4.3 specifies and short-circuits on the first failure so
 * downstream filters don't waste work on a candidate that's already going to
 * be skipped.
 *
 * Filters are pure: they read the task graph + the calibration log + the
 * task's frontmatter and return a verdict. No git / gh / network calls — the
 * orchestrator loop owns side effects (the filter chain just observes).
 *
 * Trace + event emission are the loop's job; filters return data, the loop
 * formats it into log lines + event records.
 *
 * @module orchestrator/filters/types
 */

import type { ExternalDependency } from '../../deps/dependency-graph.js';

/**
 * Names of the filters in the order the chain runs them. Used in trace
 * lines + event payloads so operators can grep for a specific filter without
 * decoding the human-readable reason string.
 *
 * `OrphanParent` (AISDLC-175) is the cheapest filter — a constant-time graph
 * lookup against the candidate's own node + the already-loaded parent map —
 * so it runs FIRST and short-circuits before the costlier dependency walk.
 * The other three filters preserve the RFC §4.3 ordering among themselves.
 */
export type FilterName =
  | 'OrphanParent'
  | 'DependencyReadiness'
  | 'DorReadiness'
  | 'ExternalDependencies';

/**
 * Single-filter outcome. `passed: true` clears the candidate; `passed: false`
 * skips it (the loop emits the matching `OrchestratorBlockedBy*` event and
 * requeues for the next tick).
 */
export interface FilterResult {
  /** Stable filter identifier for trace lines + events. */
  filter: FilterName;
  /** Whether the candidate cleared this filter. */
  passed: boolean;
  /** Short human-readable reason — populated when `passed === false`. */
  reason?: string;
  /**
   * Filter-specific structured payload — populated when `passed === false`.
   * Surfaces in the matching event so consumers can act on the typed shape
   * without re-parsing the reason string.
   */
  detail?: FilterDetail;
}

/**
 * Per-filter structured detail. Discriminated by `kind` so consumers can
 * narrow safely. Each shape carries only the fields the matching event
 * actually needs (RFC §7.1 event surface).
 */
export type FilterDetail =
  | DependencyBlockedDetail
  | DorBlockedDetail
  | AwaitingExternalDetail
  | OrphanParentDetail;

/**
 * AISDLC-175 — the candidate is a parent task whose every declared child is
 * already in `backlog/completed/`. The filter rejects so the orchestrator
 * stops dispatching developer subagents to do bookkeeping closures the
 * framework should handle (the witness was AISDLC-70 — RFC-0010 parent with
 * 9 completed children — getting picked up after PR #231 had already shipped
 * its closure).
 */
export interface OrphanParentDetail {
  kind: 'orphan-parent-needs-closure';
  /**
   * IDs of the candidate's children that are all already in
   * `backlog/completed/` (lowercased, sorted). At least one entry by
   * construction — a parent with zero children is not an orphan-parent and
   * the filter admits it.
   */
  completedChildren: string[];
}

export interface DependencyBlockedDetail {
  kind: 'dependency-blocked';
  /** Open task IDs that gate the candidate (already lowercased, sorted). */
  blockers: string[];
}

export interface DorBlockedDetail {
  kind: 'dor-blocked';
  /** The verdict that blocked admission — always `needs-clarification` in v1. */
  verdict: 'needs-clarification';
  /**
   * ISO timestamp of the blocking verdict — surfaces in the event so
   * operators can find the matching calibration log entry.
   */
  signedAt: string | null;
}

export interface AwaitingExternalDetail {
  kind: 'awaiting-external';
  /**
   * Subset of the task's `externalDependencies` that are gating dispatch.
   * v1 = entries with `kind: 'manual'` AND no operator-supplied clearance.
   * Other kinds (`npm-version`, `github-pr`, `url-head`, `other`) are
   * surfaced in the event payload but do NOT cause `passed: false`.
   */
  blocking: ExternalDependency[];
  /**
   * Full list of the task's external deps so the event payload includes
   * the non-blocking ones (informational signal per RFC §4.3).
   */
  all: ExternalDependency[];
}

/**
 * Aggregate result for a single candidate after the chain runs.
 * `passed === true` means every filter cleared (or the chain ran with no
 * filters configured — defensive); `passed === false` carries the FIRST
 * failing filter's verdict.
 */
export interface FilterChainResult {
  /** True when every filter in the chain passed (or chain was empty). */
  passed: boolean;
  /** Per-filter trace — every entry the chain evaluated (in order). */
  trace: FilterResult[];
  /**
   * The first failing filter, when `passed === false`. Convenience accessor
   * so the loop can pick the matching event type without scanning trace.
   */
  failure: FilterResult | null;
}
