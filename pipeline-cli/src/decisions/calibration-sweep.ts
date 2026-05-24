/**
 * RFC-0035 Phase 9 — substrate-corpus → pending-exemplars sweep (AISDLC-293).
 *
 * The "mirror" half of the calibration loop. Reads the substrate corpus
 * (per-task-type YAMLs) + the decision event log, and seeds
 * `pending-exemplars.yaml` with any new resolved entries (`negative` from
 * operator overrides, `positive` from silence-past-window) that aren't
 * already mirrored.
 *
 * ### Run modes
 *
 *   - `negatives-only` (default) — mirror every `negative`-polarity
 *     substrate entry. Negatives ARE the calibration signal (per AC#1);
 *     surfacing all of them is correct.
 *   - `include-positives` — also mirror `positive`-polarity entries.
 *     Off by default because positives are the bulk of the corpus and
 *     surfacing all of them swamps the operator review queue. Operators
 *     turn this on when they want to batch-promote positives for prompt-
 *     anchoring (Phase 10+ training corpus expansion).
 *
 * ### Decision-id back-traceability
 *
 * When the substrate entry was written by Stage C (`decision-recommendation`
 * task type), the entry itself doesn't carry the decision-id — the
 * stage-c-completed event in the decision log does. The sweep correlates
 * by `corpusEntryId`: read the decision log, find every
 * `stage-c-completed` event whose `stageC.corpusEntryId` matches the
 * substrate entry id, and back-fill the `decisionId` field on the pending
 * exemplar.
 *
 * For non-Stage-C task types (capture-triage, capture-severity, etc.) the
 * decision-id is left blank — those entries come from other surfaces
 * (RFC-0024 capture, DoR ingress) that don't have a Decision record.
 *
 * @module decisions/calibration-sweep
 */

import {
  ALL_TASK_TYPES,
  readCorpus,
  type CalibrationCorpusEntry,
  type ClassifierTaskType,
} from '../classifier/substrate/index.js';

import {
  appendPendingExemplar,
  buildPendingExemplar,
  readPendingExemplars,
  type PendingExemplar,
} from './pending-exemplars.js';
import { projectAll } from './projection.js';
import type { StageCCompletedEvent } from './decision-record.js';

// ── Decision-id back-fill ────────────────────────────────────────────────────

/**
 * Build a `corpusEntryId → decisionId` map by walking every Decision's
 * event log for `stage-c-completed` events. O(events) once per sweep.
 *
 * The mapping is many-to-one in principle (a Decision can have multiple
 * stage-c-completed events when the operator re-runs Stage C); we keep
 * the LAST one because the corpus entry id changes per Stage C run and
 * the latest is the one tied to the live recommendation.
 */
export function buildCorpusEntryToDecisionIdMap(workDir: string): Map<string, string> {
  const map = new Map<string, string>();
  const { decisions } = projectAll({ workDir });
  for (const decision of decisions.values()) {
    for (const evt of decision.decisionLog) {
      if (evt.type !== 'stage-c-completed') continue;
      const sc = evt as StageCCompletedEvent;
      const corpusEntryId = sc.stageC?.corpusEntryId;
      if (typeof corpusEntryId === 'string' && corpusEntryId.length > 0) {
        map.set(corpusEntryId, decision.metadata.id);
      }
    }
  }
  return map;
}

// ── Sweep ────────────────────────────────────────────────────────────────────

export interface RunSweepOpts {
  /** Project root. */
  repoRoot: string;
  /** Sweep mode — default 'negatives-only'. */
  mode?: 'negatives-only' | 'include-positives';
  /** Optional task-type filter. Defaults to all 5. */
  taskTypes?: readonly ClassifierTaskType[];
  /** Override the corpus dir (tests). */
  corpusDir?: string;
  /** Override the pending-exemplars file path (tests). */
  pendingPath?: string;
  /** ISO-8601 reference time. Default: `new Date().toISOString()`. */
  now?: string;
}

export interface RunSweepResult {
  /** Total mirrored count across all task types. */
  mirroredCount: number;
  /** Pre-existing entries skipped because the corpus-entry-id was already mirrored. */
  skippedExisting: number;
  /** Per-task-type breakdown of mirrored count. */
  perTaskType: Record<string, number>;
  /** Ids of the pending exemplars created in this run. */
  createdIds: string[];
  /** Sweep mode that was applied. */
  mode: 'negatives-only' | 'include-positives';
}

/**
 * Read every substrate corpus entry across the requested task types,
 * filter to the desired polarities per `mode`, and mirror any new ones
 * into `pending-exemplars.yaml`. Idempotent on the substrate-entry-id
 * (the appendPendingExemplar helper deduplicates).
 *
 * The sweep is **read-only** with respect to the substrate corpus —
 * Phase 9 does NOT mutate the substrate. Polarity flips remain entirely
 * the substrate's job; this just mirrors the outcomes.
 */
export function runCalibrationSweep(opts: RunSweepOpts): RunSweepResult {
  const mode = opts.mode ?? 'negatives-only';
  const taskTypes = opts.taskTypes ?? ALL_TASK_TYPES;
  const wantPositive = mode === 'include-positives';

  const decisionIdMap = buildCorpusEntryToDecisionIdMap(opts.repoRoot);

  // Pre-compute the set of already-mirrored corpus entry ids so we don't
  // ask the appendPendingExemplar dedup loop to do O(N*M) work for big
  // corpora — one pass over the file up front, then per-entry O(1) checks.
  const existingPending = readPendingExemplars(opts.repoRoot, opts.pendingPath);
  const mirroredIds = new Set(existingPending.map((e) => e.corpusEntryId));

  const perTaskType: Record<string, number> = {};
  const createdIds: string[] = [];
  let mirroredCount = 0;
  let skippedExisting = 0;

  for (const taskType of taskTypes) {
    const entries: CalibrationCorpusEntry[] = readCorpus(opts.repoRoot, taskType, opts.corpusDir);
    for (const entry of entries) {
      if (entry.polarity === 'pending') continue;
      if (entry.polarity === 'positive' && !wantPositive) continue;
      if (mirroredIds.has(entry.id)) {
        skippedExisting++;
        continue;
      }
      const decisionId = decisionIdMap.get(entry.id);
      const pending: PendingExemplar = buildPendingExemplar({
        entry,
        ...(decisionId !== undefined ? { decisionId } : {}),
        ...(opts.now !== undefined ? { now: opts.now } : {}),
      });
      const result = appendPendingExemplar(opts.repoRoot, pending, opts.pendingPath);
      if (result.appended) {
        mirroredCount++;
        perTaskType[taskType] = (perTaskType[taskType] ?? 0) + 1;
        mirroredIds.add(entry.id);
        createdIds.push(pending.id);
      } else {
        skippedExisting++;
      }
    }
  }

  return { mirroredCount, skippedExisting, perTaskType, createdIds, mode };
}
