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
 * Names of the three filters in the order RFC §4.3 specifies. Used in trace
 * lines + event payloads so operators can grep for a specific filter without
 * decoding the human-readable reason string.
 */
export type FilterName = 'DependencyReadiness' | 'DorReadiness' | 'ExternalDependencies';

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
export type FilterDetail = DependencyBlockedDetail | DorBlockedDetail | AwaitingExternalDetail;

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
