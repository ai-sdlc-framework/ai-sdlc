/**
 * Filter — Operator-blocked detection (AISDLC-223).
 *
 * Catches tasks the operator has explicitly marked as blocked via a
 * `blocked.reason` frontmatter field. The canonical use case is a task
 * that cleared every other admission gate but is held by an external
 * signal — e.g. a soak window, a pending human decision, or a dependency
 * on an event outside the task graph.
 *
 * Witness (2026-05-06): `cli-orchestrator tick` repeatedly picked
 * AISDLC-115 (RFC-0011 DoR Gate, soaking for promotion evidence). All
 * four existing filters admitted it, the orchestrator entered Steps 0-3,
 * then aborted at Step 3 because the prior session's branch already
 * existed. Even with stale-branch handling fixed, every tick wasted ~5
 * minutes on a no-op until the soak window closed.
 *
 * Frontmatter shape
 * =================
 *
 * ```yaml
 * blocked:
 *   reason: "Soaking — promotion gated on AISDLC-116 evidence"  # required
 *   until: "2026-05-13"           # optional advisory ISO date
 *   unblockedBy: ["AISDLC-116"]   # optional task-ID list to monitor
 * ```
 *
 * Only `reason` (non-empty string) gates dispatch. `until` and
 * `unblockedBy` are advisory and carried in the event payload for the
 * TUI (AISDLC-178) and future auto-unblock warnings (AC #8 / Phase 2).
 *
 * Filter position: AFTER ExternalDeps (last in the chain per AC #3).
 * Chain order: OrphanParent → DependencyReadiness → DorReadiness →
 * ExternalDependencies → Blocked.
 *
 * Pure: reads only the pre-parsed `BlockedFrontmatter` struct. No I/O.
 *
 * @module orchestrator/filters/blocked
 */

import type { FilterResult } from './types.js';

/** The `blocked:` frontmatter field shape (AC #1). */
export interface BlockedFrontmatter {
  /** Free-form human reason. Required — an absent or empty reason means not blocked. */
  reason?: string;
  /** Advisory ISO date after which the operator should re-evaluate the block. */
  until?: string;
  /** Task IDs whose completion unblocks this task (advisory, not auto-enforced in v1). */
  unblockedBy?: string[];
}

export interface CheckBlockedOpts {
  /** Candidate task ID. */
  taskId: string;
  /**
   * Pre-parsed `blocked:` frontmatter field. When undefined the filter
   * treats the task as not blocked (backward-compatible with tasks that
   * predate this field).
   */
  blocked?: BlockedFrontmatter;
}

/**
 * Check whether the candidate task is operator-blocked.
 *
 * Returns `{ filter: 'Blocked', passed: false, reason: <reason> }` when
 * `blocked.reason` is a non-empty string; returns `{ filter: 'Blocked',
 * passed: true }` otherwise (including when the field is entirely absent).
 *
 * Pure — no I/O. The caller loads the frontmatter and passes the parsed
 * struct here.
 */
export function checkBlocked(opts: CheckBlockedOpts): FilterResult {
  const reason = opts.blocked?.reason?.trim() ?? '';
  if (reason === '') {
    return { filter: 'Blocked', passed: true };
  }

  const detail: BlockedDetail = {
    kind: 'blocked',
    reason,
    ...(opts.blocked?.until !== undefined ? { until: opts.blocked.until } : {}),
    ...(opts.blocked?.unblockedBy !== undefined && opts.blocked.unblockedBy.length > 0
      ? { unblockedBy: opts.blocked.unblockedBy }
      : {}),
  };

  return {
    filter: 'Blocked',
    passed: false,
    reason,
    detail,
  };
}

/**
 * Structured detail carried in the `OrchestratorTaskBlocked` event.
 * Discriminated by `kind: 'blocked'` so downstream consumers can narrow
 * the `FilterDetail` union without re-parsing the reason string.
 */
export interface BlockedDetail {
  kind: 'blocked';
  /** Free-form human-readable reason — mirrors `blocked.reason`. */
  reason: string;
  /** Advisory ISO date — mirrors `blocked.until` when present. */
  until?: string;
  /** Task IDs that should unblock this task when completed — mirrors `blocked.unblockedBy`. */
  unblockedBy?: string[];
}
