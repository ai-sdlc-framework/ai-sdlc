/**
 * RFC-0035 Phase 5 — shared corpus aggregator (AISDLC-289 / AC#4).
 *
 * The RFC-0024 shared classifier substrate maintains five separate
 * per-task-type calibration corpus files in
 * `<repoRoot>/.ai-sdlc/classifier-corpus/` (one YAML per task type:
 * capture-triage, capture-severity, pr-comment-is-capture,
 * dor-answer-is-new-concern, decision-recommendation).
 *
 * Per OQ-3 / §15.1 Design Pattern 4 ("Single shared LLM classifier
 * corpus"), one classifier serves all surfaces and **one calibration
 * corpus** spans all of them. This aggregator is the read-side
 * projection that exposes the unified view — it does not own storage
 * (the substrate's per-task-type files remain the source of truth) but
 * composes them into a single aggregate metric set + exemplar promotion
 * pipeline.
 *
 * ### What this module composes
 *
 * - **Per-task-type roll-up** — confidence histogram, positive/negative/
 *   pending counts, accuracy (positive / (positive + negative)), avg
 *   confidence per polarity.
 * - **Cross-task-type aggregate** — same metrics but summed across all
 *   task types.
 * - **Anchor candidates** — corpus entries with `polarity: 'negative'`
 *   that meet promotion criteria (≥ `anchorPromotionThreshold` negative
 *   entries with the same operator-chosen classification per task type
 *   per OQ-11). These are surfaced for operator confirmation; the
 *   actual promotion to "anchor" is operator-driven (see
 *   `cli-decisions corpus tag-anchor` in the CLI).
 *
 * ### What this module does NOT do
 *
 * - Write to the substrate corpus files — only `appendCorpusEntry()` and
 *   `setCorpusEntryPolarity()` from the substrate may mutate corpus.
 * - Generate the Stage C prompt — the substrate owns prompt templates.
 * - Decide whether to auto-apply a Stage C recommendation — that's the
 *   Stage C runner's job (see `stage-c.ts: isStageCAutoApplyEligible`).
 *
 * The aggregator is invoked by:
 *   - `cli-decisions corpus aggregate` — operator-facing summary report.
 *   - The TUI calibration pane (RFC-0023 Phase 9 — not in this PR).
 *   - The orchestrator's nightly calibration tick (Phase 9 follow-up).
 *
 * @module decisions/corpus-aggregator
 */

import {
  ALL_TASK_TYPES,
  readCorpus,
  type CalibrationCorpusEntry,
  type ClassifierTaskType,
} from '../classifier/substrate/index.js';

// ── Per-task-type roll-up ─────────────────────────────────────────────────────

/**
 * Aggregate counts + accuracy metrics for ONE task type's corpus file.
 *
 * `accuracy` = `positive / (positive + negative)` — the share of
 * resolved classifications the operator confirmed. `pending` entries
 * (still inside the override window) are excluded from accuracy because
 * their outcome is undetermined.
 *
 * `coverage` = `resolved / total` — the share of corpus entries whose
 * override-window outcome is known. Useful for spotting when the
 * substrate is generating new classifications faster than the override
 * window can settle them.
 */
export interface PerTaskTypeMetrics {
  taskType: ClassifierTaskType;
  total: number;
  positive: number;
  negative: number;
  pending: number;
  /** positive / (positive + negative) — undefined when no resolved entries. */
  accuracy: number | null;
  /** resolved / total — undefined when total is 0. */
  coverage: number | null;
  /** Avg LLM confidence across all entries (regardless of polarity). */
  avgConfidence: number | null;
  /** Avg confidence on the subset with polarity 'positive'. */
  avgConfidencePositive: number | null;
  /** Avg confidence on the subset with polarity 'negative'. */
  avgConfidenceNegative: number | null;
}

function aggregateOne(
  taskType: ClassifierTaskType,
  entries: CalibrationCorpusEntry[],
): PerTaskTypeMetrics {
  let positive = 0;
  let negative = 0;
  let pending = 0;
  let sumConfidence = 0;
  let sumConfPos = 0;
  let sumConfNeg = 0;
  for (const e of entries) {
    sumConfidence += e.confidence;
    if (e.polarity === 'positive') {
      positive++;
      sumConfPos += e.confidence;
    } else if (e.polarity === 'negative') {
      negative++;
      sumConfNeg += e.confidence;
    } else {
      pending++;
    }
  }
  const total = entries.length;
  const resolved = positive + negative;
  return {
    taskType,
    total,
    positive,
    negative,
    pending,
    accuracy: resolved > 0 ? round3(positive / resolved) : null,
    coverage: total > 0 ? round3(resolved / total) : null,
    avgConfidence: total > 0 ? round3(sumConfidence / total) : null,
    avgConfidencePositive: positive > 0 ? round3(sumConfPos / positive) : null,
    avgConfidenceNegative: negative > 0 ? round3(sumConfNeg / negative) : null,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── Cross-task-type aggregate ─────────────────────────────────────────────────

/**
 * Sum across all per-task-type roll-ups. `accuracy` and `coverage` are
 * re-derived from the aggregate counts (not averaged across per-task
 * accuracies — that would weight each task type equally regardless of
 * volume).
 */
export interface CrossTaskAggregate {
  total: number;
  positive: number;
  negative: number;
  pending: number;
  accuracy: number | null;
  coverage: number | null;
}

function sumPerTask(metrics: readonly PerTaskTypeMetrics[]): CrossTaskAggregate {
  let total = 0;
  let positive = 0;
  let negative = 0;
  let pending = 0;
  for (const m of metrics) {
    total += m.total;
    positive += m.positive;
    negative += m.negative;
    pending += m.pending;
  }
  const resolved = positive + negative;
  return {
    total,
    positive,
    negative,
    pending,
    accuracy: resolved > 0 ? round3(positive / resolved) : null,
    coverage: total > 0 ? round3(resolved / total) : null,
  };
}

// ── Anchor-candidate detection (OQ-11 promotion criteria) ─────────────────────

/**
 * Promotion criterion from OQ-11: an exemplar becomes a "calibration
 * anchor" when at least `anchorPromotionThreshold` operator overrides
 * point at the same operator-chosen classification for the same task
 * type. Anchors are pulled into the substrate's prompt-anchoring layer
 * (Phase 9) to nudge future LLM responses away from systematic mis-
 * classifications.
 *
 * Default threshold: 3 (OQ-11 resolution). Configurable via
 * `decisions-config.yaml: anchorPromotionThreshold` (read by the
 * aggregator at call time; not centralised in resolveDecisionsConfig
 * yet because the aggregator is the only consumer in Phase 5).
 */
export const ANCHOR_PROMOTION_THRESHOLD = 3;

/**
 * One anchor-candidate cluster. Identifies a group of corpus entries
 * with `polarity: 'negative'` that the operator consistently corrected
 * to the same `operatorOverrideClassification` value.
 *
 * Operators promote a cluster by tagging one of its entries with
 * `cli-decisions corpus tag-anchor <event-id>` (Phase 9 — not in this
 * PR; the CLI is wired up here so operators can identify candidates).
 */
export interface AnchorCandidate {
  taskType: ClassifierTaskType;
  /** The operator-chosen classification all entries in this cluster share. */
  operatorOverrideClassification: string;
  /** Number of corpus entries in this cluster. */
  count: number;
  /** Corpus entry ids in this cluster (for the CLI to surface). */
  entryIds: string[];
  /** Avg confidence the LLM had on its (wrong) recommendation across the cluster. */
  avgConfidenceWhenWrong: number;
}

function detectAnchorCandidates(
  taskType: ClassifierTaskType,
  entries: CalibrationCorpusEntry[],
  threshold: number,
): AnchorCandidate[] {
  // Group negatives by operatorOverrideClassification.
  const groups = new Map<string, CalibrationCorpusEntry[]>();
  for (const e of entries) {
    if (e.polarity !== 'negative') continue;
    const key = e.operatorOverrideClassification ?? '<missing>';
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }
  const out: AnchorCandidate[] = [];
  for (const [key, cluster] of groups) {
    if (cluster.length < threshold) continue;
    const sumConf = cluster.reduce((s, e) => s + e.confidence, 0);
    out.push({
      taskType,
      operatorOverrideClassification: key,
      count: cluster.length,
      entryIds: cluster.map((e) => e.id),
      avgConfidenceWhenWrong: round3(sumConf / cluster.length),
    });
  }
  // Largest clusters first — operator attention is finite.
  out.sort((a, b) => b.count - a.count);
  return out;
}

// ── Aggregate (full) ──────────────────────────────────────────────────────────

export interface AggregateCorpusOpts {
  /** Project root. Defaults to `process.cwd()`. */
  workDir?: string;
  /** Optional per-task filter. Defaults to all 5 task types. */
  taskTypes?: readonly ClassifierTaskType[];
  /** Override the anchor-promotion threshold. Default: ANCHOR_PROMOTION_THRESHOLD. */
  anchorPromotionThreshold?: number;
  /** Corpus directory override (tests + multi-corpus). */
  corpusDir?: string;
}

export interface AggregateCorpusResult {
  /** Per-task-type metrics, in task-type-enum order. */
  perTaskType: PerTaskTypeMetrics[];
  /** Cross-task-type rollup (sums across `perTaskType`). */
  aggregate: CrossTaskAggregate;
  /** Anchor-candidate clusters across all task types. */
  anchorCandidates: AnchorCandidate[];
  /** Threshold actually used (config or default). */
  anchorPromotionThreshold: number;
}

/**
 * Aggregate the substrate's calibration corpus across every task type
 * (or the subset declared by `opts.taskTypes`). Returns metrics + anchor
 * candidates without mutating any corpus file. The result is shaped for
 * direct JSON serialisation in the CLI / TUI.
 *
 * Empty corpus → returns zeroed metrics + empty candidates (not an
 * error; calibration starts empty by definition).
 */
export function aggregateDecisionCorpus(opts: AggregateCorpusOpts = {}): AggregateCorpusResult {
  const workDir = opts.workDir ?? process.cwd();
  const taskTypes = opts.taskTypes ?? ALL_TASK_TYPES;
  const threshold = opts.anchorPromotionThreshold ?? ANCHOR_PROMOTION_THRESHOLD;

  const perTaskType: PerTaskTypeMetrics[] = [];
  const anchorCandidates: AnchorCandidate[] = [];

  for (const tt of taskTypes) {
    const entries = readCorpus(workDir, tt, opts.corpusDir);
    perTaskType.push(aggregateOne(tt, entries));
    const candidates = detectAnchorCandidates(tt, entries, threshold);
    anchorCandidates.push(...candidates);
  }

  return {
    perTaskType,
    aggregate: sumPerTask(perTaskType),
    anchorCandidates,
    anchorPromotionThreshold: threshold,
  };
}
