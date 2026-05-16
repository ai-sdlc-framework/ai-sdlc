/**
 * `estimateInputHash` — RFC-0016 §8.4 (Q5 resolution).
 *
 * Content hash over the materially-LLM-affecting inputs of a Stage A
 * estimate:
 *
 *   `estimateInputHash = sha256(taskTitle + taskDescription + stageA_signals + classAssignment)`
 *
 * The hash is the disambiguator between "same prompt, two samples"
 * (ensemble noise — aggregates) versus "different prompt" (the task
 * itself changed — starts a fresh ensemble). See §8.4:
 *
 *  - Same hash + ≥2 entries in `_estimates/log.jsonl` → calibration
 *    uses the median bucket across the batch (robust to one outlier).
 *  - Different hash → previous-hash entries stay in the log but DO NOT
 *    aggregate with the new hash's batch. The `EstimateInputChanged`
 *    event marks the transition.
 *
 * Determinism is mission-critical here — two runs against the same
 * inputs MUST produce the same hash, even across machines / Node
 * versions. We canonicalise everything before hashing:
 *
 *  - Object keys sorted alphabetically (`sortedJsonStringify`).
 *  - Signals projected onto a stable shape that drops human-readable
 *    fields (e.g. `name`) — those rot when the §5.1 catalogue is
 *    re-worded, while the underlying `id` + `result` carry the actual
 *    decision content.
 *  - Class assignment reduced to `taskClass` only — the `source`
 *    (frontmatter / heuristic / default) is provenance metadata, NOT
 *    a material input.
 *
 * @module estimation/hash
 */

import { createHash } from 'node:crypto';
import type { SignalOutput, TaskClass } from './types.js';

export interface EstimateInputHashArgs {
  taskTitle: string;
  /** Empty string when the task has no `## Description` block. */
  taskDescription: string;
  /**
   * The §5.1 signal multiset that produced the Stage A verdict. Order
   * is normalised by `id` before hashing so the caller doesn't need to
   * sort the array first.
   */
  stageASignals: readonly SignalOutput[];
  /** The class the task was assigned. `source` is intentionally NOT part of the hash. */
  taskClass: TaskClass;
}

/**
 * Compute the content hash. Returns a `sha256:<hex>` string so the log
 * line is unambiguous about the algorithm — future versions can bump to
 * `sha3-256:` without breaking parse.
 */
export function computeEstimateInputHash(args: EstimateInputHashArgs): string {
  const canonical = sortedJsonStringify({
    taskTitle: args.taskTitle,
    taskDescription: args.taskDescription,
    taskClass: args.taskClass,
    stageASignals: [...args.stageASignals].map(projectSignal).sort((a, b) => a.id - b.id),
  });
  const hex = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

/**
 * Drop the human-readable `name` field and re-key `inputs` so signal
 * renaming in the catalogue doesn't invalidate every cached hash.
 *
 * The shape captured here MUST stay stable. Any future change to this
 * function is a hash-version bump (rename to `computeEstimateInputHashV2`,
 * not edit-in-place) so historical log entries remain queryable.
 */
function projectSignal(s: SignalOutput): {
  id: number;
  inputs: Record<string, unknown>;
  result: SignalOutput['result'];
} {
  return {
    id: s.id,
    inputs: sortKeys(s.inputs),
    result: s.result,
  };
}

/**
 * Recursively sort object keys so `JSON.stringify` produces a canonical
 * form. Arrays preserve order (their order is semantic — the caller is
 * responsible for sorting them before passing in if needed).
 */
function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(sortKeys) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out as unknown as T;
  }
  return value;
}

/** Convenience — `JSON.stringify` after `sortKeys`. Exported for tests. */
export function sortedJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
