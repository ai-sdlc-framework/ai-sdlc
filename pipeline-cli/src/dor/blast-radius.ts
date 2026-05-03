/**
 * Blast-radius computation for DoR composition (RFC-0014 Phase 3 / §6).
 *
 * Given a task ID and the AISDLC-166 snapshot artifact (or any compatible
 * dependents map), return the count + sample of downstream tasks that
 * would unblock if the target shipped. The DoR comment loop appends this
 * as a callout when the verdict is `needs-clarification` (or as the
 * maintainer-tone bypass variant when `dor-bypass` was applied — see Q5
 * resolution in `pipeline-cli/docs/deps.md`).
 *
 * Pure function — no I/O. Inputs are the records produced by
 * `computeSnapshotRecords()` (Phase 1) so callers can either:
 *   - read a previously-written snapshot file off disk, or
 *   - compute records in-process via `computeSnapshotRecords(graph)`.
 *
 * Cycle-safe: a cycle in the reverse-edge closure short-circuits at the
 * first re-entry rather than recursing forever. Validity is the
 * snapshot's responsibility (`cli-deps validate` flags cycles
 * separately).
 *
 * @module dor/blast-radius
 */

import type { SnapshotRecord } from '../deps/snapshot.js';

/**
 * Cap on the inline downstream-id list embedded in the DoR comment +
 * calibration log. Keeps the rendered comment readable on dense chains
 * without losing the count signal — overflow renders as "(and N more)".
 *
 * 10 ids is enough to recognise a chain ("yes, those are the dispatch
 * leaves I was worried about") without dragging the comment over the
 * fold on a typical PR-page width. Adjustable via `BlastRadiusOpts.maxIds`.
 */
export const DEFAULT_BLAST_RADIUS_MAX_IDS = 10;

/**
 * Cap on the calibration-log `downstreamSampleIds` array. Smaller than
 * the comment cap by design — calibration consumers (`cli-dor-stats`,
 * `cli-dor-corpus --blast-radius`) only need the head of the list to
 * re-derive distributions; the full closure lives in the snapshot.
 */
export const DEFAULT_CALIBRATION_SAMPLE_IDS = 5;

export interface BlastRadius {
  /**
   * Total transitive downstream count (direct + indirect dependents).
   * 0 for graph leaves (no task depends on this one) and for unknown
   * task IDs (caller is responsible for distinguishing the two via
   * the `targetExists` flag).
   */
  count: number;
  /**
   * Up to `maxIds` downstream task IDs in deterministic order
   * (lexicographic with numeric suffix awareness — same sort the
   * snapshot writer uses). Capped at `maxIds`; overflow surfaces via
   * `truncated`.
   */
  downstream: string[];
  /**
   * Number of additional downstream IDs beyond the cap. 0 when
   * `count <= maxIds`. Lets the comment renderer print "(and N more)"
   * without doing math at the call site.
   */
  truncated: number;
  /**
   * Whether the target ID resolved to a known node in the snapshot.
   * `false` means the caller passed an unknown ID — a typo or a deleted
   * task. `count` will be 0 in this case but it's NOT the same as a
   * leaf task (which has `targetExists: true`, `count: 0`).
   */
  targetExists: boolean;
}

export interface BlastRadiusOpts {
  /** Cap on `downstream` length. Defaults to {@link DEFAULT_BLAST_RADIUS_MAX_IDS}. */
  maxIds?: number;
}

/**
 * Compute the transitive blast radius of a task from a snapshot.
 *
 * @param taskId   Target task ID (case-insensitive lookup).
 * @param records  Snapshot records — typically `computeSnapshotRecords(graph)`
 *                 OR the parsed contents of a `_deps/snapshot.*.jsonl` file.
 * @param opts     Optional caps.
 *
 * @returns `{ count, downstream, truncated, targetExists }`.
 */
export function computeBlastRadius(
  taskId: string,
  records: SnapshotRecord[],
  opts: BlastRadiusOpts = {},
): BlastRadius {
  const maxIds = opts.maxIds ?? DEFAULT_BLAST_RADIUS_MAX_IDS;

  // Index records by lowercase id for case-insensitive lookups + cheap
  // dependents traversal. The snapshot already carries the reverse-edge
  // set per record (`dependents`), so the closure walk doesn't need to
  // rebuild a full reverse adjacency map.
  const byId = new Map<string, SnapshotRecord>();
  for (const r of records) byId.set(r.id.toLowerCase(), r);

  const target = byId.get(taskId.toLowerCase());
  if (!target) {
    return { count: 0, downstream: [], truncated: 0, targetExists: false };
  }

  // Iterative DFS over the reverse edges. Cycle-safe via `visited`.
  // Pre-seed `visited` with the target's own key so a cycle that loops
  // back to the target doesn't double-count the target itself in its
  // own blast radius (the count answers "how many OTHER tasks does
  // this gate?", not "how many nodes are reachable").
  const targetKey = target.id.toLowerCase();
  const visited = new Set<string>([targetKey]);
  const out: string[] = [];
  const stack: string[] = [...target.dependents];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    const key = next.toLowerCase();
    if (visited.has(key)) continue;
    visited.add(key);
    const node = byId.get(key);
    if (!node) {
      // Dangling reverse edge — record points at an id that's not in
      // the snapshot. Count it (we DID see the edge) but skip recursion.
      out.push(next);
      continue;
    }
    out.push(node.id);
    for (const child of node.dependents) stack.push(child);
  }

  // Deterministic order — same locale-numeric sort the snapshot writer
  // uses on its `dependents` arrays so the rendered comment matches the
  // operator's mental model of "AISDLC-100.1, .2, .3, .4, ...".
  out.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

  const count = out.length;
  const truncated = Math.max(0, count - maxIds);
  const downstream = truncated > 0 ? out.slice(0, maxIds) : out;
  return { count, downstream, truncated, targetExists: true };
}

/**
 * Render the standard blast-radius callout for a `Needs Clarification`
 * verdict. RFC-0014 §6.2 + §12 Q5 (standard verdict template).
 *
 * Returns the empty string when the radius is 0 — graph leaves don't get
 * a callout (no point telling the author "this gates 0 tasks").
 */
export function renderBlastRadiusCallout(radius: BlastRadius): string {
  if (radius.count === 0) return '';
  const head = radius.downstream.join(', ');
  const tail = radius.truncated > 0 ? `${head}, ... (and ${radius.truncated} more)` : head;
  return (
    `> ⚠ This issue currently gates ${radius.count} downstream task` +
    `${radius.count === 1 ? '' : 's'} (${tail}). ` +
    `Resolving the questions above unblocks the entire chain.`
  );
}

/**
 * Render the Q5 maintainer-tone variant — fired when a `dor-bypass`
 * label admits a high-radius task. Different audience (the maintainer
 * who applied the bypass), different tone (FYI, not "do this"), same
 * data (count + sample ids).
 *
 * Returns the empty string when the radius is below the configured
 * threshold (the bypass on a leaf or shallow-chain task isn't a strong
 * calibration signal worth nagging about).
 */
export function renderBypassBlastRadiusCallout(
  radius: BlastRadius,
  highRadiusThreshold: number,
): string {
  if (radius.count < highRadiusThreshold) return '';
  const head = radius.downstream.join(', ');
  const tail = radius.truncated > 0 ? `${head}, ... (and ${radius.truncated} more)` : head;
  return (
    `> ℹ This bypass admits a task gating ${radius.count} downstream item` +
    `${radius.count === 1 ? '' : 's'} (${tail}). ` +
    `Confirm intentional — high blast radius is a strong calibration signal ` +
    `that the rubric may be missing something.`
  );
}

/**
 * Render the Q3 external-dependencies callout. Pure signal in v1: the
 * dispatcher does NOT block on these, but the DoR comment surfaces the
 * count so authors see "you've also declared N out-of-graph blockers".
 *
 * Returns the empty string when no externals are declared.
 */
export function renderExternalDependenciesCallout(externalCount: number): string {
  if (externalCount <= 0) return '';
  return (
    `> ⚠ External dependencies tracked: ${externalCount}. ` +
    `These are surfaced for awareness — the dispatcher does not block on them in v1.`
  );
}

/**
 * Reduce a `BlastRadius` to the calibration-log shape — count + a small
 * sample of downstream ids. Capped at {@link DEFAULT_CALIBRATION_SAMPLE_IDS}
 * by default (smaller than the comment cap; the calibration consumer only
 * needs the head of the list).
 */
export function blastRadiusForCalibration(
  radius: BlastRadius,
  sampleSize = DEFAULT_CALIBRATION_SAMPLE_IDS,
): { count: number; downstreamSampleIds: string[] } {
  return {
    count: radius.count,
    downstreamSampleIds: radius.downstream.slice(0, sampleSize),
  };
}
