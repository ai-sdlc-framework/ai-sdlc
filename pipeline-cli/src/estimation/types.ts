/**
 * Types — RFC-0016 Phase 1 (AISDLC-279).
 *
 * Shared shape definitions for the Stage A deterministic-only estimator.
 * Every signal collector returns a `SignalOutput`; the aggregator folds
 * the multiset of outputs into a single `StageAResult`. No runtime
 * dependencies — purely structural.
 *
 * Phase 1 surface only: no Stage B / LLM types, no calibration-log
 * schema, no estimate-input-hash. Those land in Phases 2-4.
 *
 * @module estimation/types
 */

/**
 * RFC-0016 §4.1 t-shirt bucket enum.
 *
 * Ordered numerically so the aggregator can compute "adjacent bucket"
 * relationships (e.g. S+M is a 1-bucket spread, S+L is a 2-bucket
 * spread). Use `BUCKET_INDEX` to map a bucket label to its ordinal.
 */
export type Bucket = 'XS' | 'S' | 'M' | 'L' | 'XL';

export const BUCKETS: readonly Bucket[] = ['XS', 'S', 'M', 'L', 'XL'] as const;

/** Ordinal lookup; useful for adjacency math. */
export const BUCKET_INDEX: Record<Bucket, number> = {
  XS: 0,
  S: 1,
  M: 2,
  L: 3,
  XL: 4,
};

/**
 * RFC-0016 §6.1 starter task-class taxonomy (3 convergent classes).
 *
 * `uncategorized` is the synthetic fall-back used when the LLM
 * classifier returns confidence < 0.70 (per §6.1 confidence gates).
 * Phase 1 uses a deterministic heuristic (NOT the LLM) — see
 * `class-assignment.ts` — so `uncategorized` here surfaces when the
 * heuristic can't pattern-match either.
 */
export type TaskClass = 'bug' | 'feature' | 'chore' | 'uncategorized';

export const TASK_CLASSES: readonly TaskClass[] = [
  'bug',
  'feature',
  'chore',
  'uncategorized',
] as const;

/**
 * RFC-0016 §13 Phase 1 — class-default seed buckets (Q8 resolution).
 *
 * These are the catalogue medians per class that signal #9 falls back
 * to when historical actuals (signal #2) returns `unknown` (n<5 for
 * the class). Phase 3 retires these gracefully as real signal #2
 * calibration data flows in.
 */
export const CLASS_DEFAULT_BUCKET: Record<TaskClass, Bucket> = {
  bug: 'S',
  feature: 'M',
  chore: 'S',
  uncategorized: 'M',
};

/**
 * RFC-0016 §5.1 signal identity (catalogue row #).
 *
 * Stable across surfaces — the CLI table, the JSON output, and the
 * (Phase 2) `_estimates/log.jsonl` capture all key on this number so
 * downstream consumers don't have to pattern-match on the `name`
 * string.
 */
export type SignalId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * Per-signal outputs. Each collector returns ONE of:
 *
 *  - `bucket` — the signal points squarely at a single bucket (e.g.
 *    "1 file → XS").
 *  - `range` — the signal straddles 2 adjacent buckets (e.g. "1 .ts
 *    test file → XS-S" per §5.3).
 *  - `bump` — the signal isn't a bucket on its own but contributes a
 *    per-bucket adjustment (`+1` for blocked-paths-touched, `+0` for
 *    inert).
 *  - `unknown` — the signal can't be computed (cold-start n<5,
 *    missing input, etc.). The aggregator treats `unknown` signals as
 *    non-voting.
 *
 * The discriminator is `result.kind`. Use a switch — strict-TS will
 * enforce exhaustiveness at every call site.
 */
export type SignalResult =
  | { kind: 'bucket'; bucket: Bucket }
  | { kind: 'range'; low: Bucket; high: Bucket }
  | { kind: 'bump'; delta: number }
  | { kind: 'unknown'; reason: string };

/**
 * One row in the §5.1 signal table. The `inputs` map captures the
 * raw values the collector consumed so a Phase 2 capture writer can
 * re-derive the answer without re-running the collector.
 */
export interface SignalOutput {
  /** §5.1 catalogue row # (1-9). */
  id: SignalId;
  /** Short human-readable label — matches the §5.1 table verbatim. */
  name: string;
  /** Snapshot of the inputs the collector consumed (for audit). */
  inputs: Record<string, unknown>;
  /** Discriminated-union result. */
  result: SignalResult;
}

/**
 * RFC-0016 §5.2 confidence rating.
 *
 *  - `high` — all resolved signals point at the same bucket.
 *  - `medium` — resolved signals split across 2 adjacent buckets.
 *  - `low` — resolved signals split across non-adjacent buckets (the
 *    "escalate to Stage B" case in Phase 4).
 */
export type StageAConfidence = 'high' | 'medium' | 'low';

/**
 * Output of `runStageA`. Aggregates the 9 signal rows + bucket choice
 * + confidence + Stage B routing hint. Phase 1 never invokes Stage B
 * — the `escalateToStageB` flag is a forward-compatibility signal
 * for Phase 4.
 */
export interface StageAResult {
  taskId: string;
  taskClass: TaskClass;
  /**
   * Where the class assignment came from. `frontmatter` = the task
   * file's `class:` field was set. `heuristic` = the Phase 1 keyword
   * pattern picked it. `default` = neither matched, fell back to
   * `feature`.
   */
  classSource: 'frontmatter' | 'heuristic' | 'default';
  signals: SignalOutput[];
  /**
   * Single-bucket choice when confidence ≥ medium AND all voting
   * signals collapse to one bucket. When confidence = medium and
   * signals straddle 2 adjacent buckets, `candidateBucket` is the
   * LOWER of the two (so a numeric consumer always has a single
   * value) and `candidateRange` is populated.
   */
  candidateBucket: Bucket;
  candidateRange?: { low: Bucket; high: Bucket };
  confidence: StageAConfidence;
  /**
   * Phase 4 hook — `true` when Stage A's signals split across
   * non-adjacent buckets, OR when ≥3 buckets are present. Phase 1
   * sets the flag but does NOT invoke Stage B (the LLM tie-breaker
   * is Phase 4 surface).
   */
  escalateToStageB: boolean;
  /** One-line human-readable summary of the aggregator's reasoning. */
  rationale: string;
}
