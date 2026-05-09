/**
 * Filter — Dispatchability detection (AISDLC-243).
 *
 * Catches tasks the operator has permanently marked as non-dispatchable via
 * `dispatchable: false` in task frontmatter. This replaces the overloaded
 * `blocked.reason` workaround for tasks that are NEVER meant to be picked
 * up by the orchestrator's developer subagent (soak phases, manual-only
 * operator steps, investigations that require human judgment, etc.).
 *
 * Motivation (2026-05-07): AISDLC-178.7 (operator soak phase, NOT code work)
 * was picked by the orchestrator twice, dev ran ~20min each time, aborted on
 * the coverage gate — wasted ~40min subscription time before the operator
 * added a manual workaround via `blocked.reason`. The `blocked.reason` field
 * is semantically wrong for the permanent case (it was designed for
 * "awaiting external signal", not "permanently not LLM-dispatchable").
 *
 * Frontmatter shape
 * =================
 *
 * ```yaml
 * dispatchable: false           # explicit opt-out; default true (back-compat)
 * dispatchableReason: "Operator soak phase — no code work"  # optional advisory
 * ```
 *
 * Omitting the field entirely means `dispatchable: true` (backward-compatible).
 * Any value other than `false` (including the string `"false"`) is treated as
 * dispatchable — the field is a strict boolean gate.
 *
 * Refinement heuristic (AC #4): the DoR refinement reviewer may suggest
 * `dispatchable: false` when the title/body matches soak, investigation, or
 * operator-only patterns. That heuristic is LLM-judged externally and DOES NOT
 * affect this filter's runtime behaviour — the filter only reads the
 * already-set frontmatter field.
 *
 * Filter position: AFTER DependencyReadiness, BEFORE DorReadiness.
 * Chain order: OrphanParent → AlreadyInFlight → DependencyReadiness →
 * Dispatchability → DorReadiness → ExternalDependencies → Blocked.
 *
 * Pure: reads only the pre-parsed `dispatchable` bool + optional
 * `dispatchableReason` string. No I/O.
 *
 * @module orchestrator/filters/dispatchability
 */

import type { FilterResult } from './types.js';

export interface CheckDispatchabilityOpts {
  /** Candidate task ID. */
  taskId: string;
  /**
   * Pre-parsed `dispatchable:` frontmatter field. When undefined the filter
   * treats the task as dispatchable (backward-compatible with tasks that
   * predate this field). When `false`, the filter rejects the candidate.
   */
  dispatchable?: boolean;
  /**
   * Optional advisory reason — mirrors `dispatchableReason` frontmatter
   * field. Carried in the trace so operators can see WHY a task is
   * non-dispatchable without opening the task file.
   */
  dispatchableReason?: string;
}

/**
 * Check whether the candidate task has been marked non-dispatchable.
 *
 * Returns `{ filter: 'Dispatchability', passed: false, reason, detail }`
 * when `dispatchable === false`; returns `{ filter: 'Dispatchability',
 * passed: true }` otherwise (including when the field is entirely absent,
 * treating the absent case as `true` for backward compatibility).
 *
 * Pure — no I/O. The caller loads the frontmatter and passes the parsed
 * value here.
 */
export function checkDispatchability(opts: CheckDispatchabilityOpts): FilterResult {
  // Absent field → dispatchable:true (back-compat default).
  if (opts.dispatchable !== false) {
    return { filter: 'Dispatchability', passed: true };
  }

  const reason = opts.dispatchableReason ?? 'marked dispatchable:false in frontmatter';
  const detail: DispatchabilityBlockedDetail = {
    kind: 'not-dispatchable',
    dispatchableReason: reason,
  };

  return {
    filter: 'Dispatchability',
    passed: false,
    reason,
    detail,
  };
}

/**
 * Structured detail carried in the `OrchestratorBlockedByDispatchability`
 * event. Discriminated by `kind: 'not-dispatchable'` so downstream
 * consumers can narrow the `FilterDetail` union without re-parsing the
 * reason string.
 */
export interface DispatchabilityBlockedDetail {
  kind: 'not-dispatchable';
  /**
   * The advisory reason from `dispatchableReason` frontmatter — or a
   * generated default when the field is absent. Surfaces in the filter
   * trace and event payload so operators can grep events.jsonl to
   * understand the skip reason without opening the task file.
   */
  dispatchableReason: string;
}
