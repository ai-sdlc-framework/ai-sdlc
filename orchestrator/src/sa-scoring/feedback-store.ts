/**
 * SA feedback store (RFC-0008 Addendum B §B.8).
 *
 * Wraps the `did_feedback_events` table and exposes precision
 * aggregations used by the feedback flywheel (AISDLC-65 Cκ
 * calibration, AISDLC-66 phase-weight auto-calibration).
 *
 * Signal semantics (§B.8.1):
 *   accept    — admitted item was correctly scored (true-positive on positive path)
 *   dismiss   — admitted item should NOT have been (false-positive)
 *   escalate  — scored too low; should have been ranked higher (false-negative)
 *   override  — HC_override bypass triggered; feedback auto-emitted
 */

import type { StateStore } from '../state/store.js';
import type { DidFeedbackEventRecord, FeedbackSignal, SaDimension } from '../state/types.js';

// ── Public API ───────────────────────────────────────────────────────

export interface RecordFeedbackInput {
  didName: string;
  issueNumber: number;
  dimension: SaDimension;
  signal: FeedbackSignal;
  principal?: string;
  /** Optional category label — e.g. product/design/engineering pillar, or custom. */
  category?: string;
  /** Layer 2 structural score at admission time (for precision tracking). */
  structuralScore?: number;
  /** Layer 3 LLM score at admission time. */
  llmScore?: number;
  /** Composite SA score. */
  compositeScore?: number;
  notes?: string;
}

export interface PrecisionWindow {
  /** ISO timestamp — filter feedback events newer than this. */
  since?: string;
  /** Filter to one dimension. */
  dimension?: SaDimension;
}

export interface PrecisionResult {
  /** Sample size after filters. */
  sampleSize: number;
  /** Directionally-correct count (accept/escalate when score was high, dismiss when score was low). */
  correct: number;
  /** Precision = correct / sampleSize. 0 when sampleSize=0. */
  precision: number;
}

export interface CategoryFalsePositive {
  category: string;
  sampleSize: number;
  falsePositiveCount: number;
  falsePositiveRate: number;
}

// Directional-correctness threshold: score ≥ this counts as "high" for
// dismiss-signal evaluation (a high-scored item that got dismissed was
// over-scored, so directionally incorrect).
const HIGH_SCORE_THRESHOLD = 0.5;

// ── Store ────────────────────────────────────────────────────────────

export class SAFeedbackStore {
  private readonly store: StateStore;

  constructor(store: StateStore) {
    this.store = store;
  }

  record(input: RecordFeedbackInput): number {
    return this.store.recordDidFeedback({
      didName: input.didName,
      issueNumber: input.issueNumber,
      dimension: input.dimension,
      signal: input.signal,
      principal: input.principal,
      category: input.category,
      structuralScore: input.structuralScore,
      llmScore: input.llmScore,
      compositeScore: input.compositeScore,
      notes: input.notes,
    });
  }

  list(window: PrecisionWindow = {}): DidFeedbackEventRecord[] {
    return this.store.getDidFeedbackEvents({
      dimension: window.dimension,
      since: window.since,
      limit: 5000,
    });
  }

  /**
   * Directional correctness of the Layer 2 structural score.
   *
   *   signal=accept   + structural ≥ 0.5 → correct (high score → accepted)
   *   signal=accept   + structural < 0.5 → incorrect (low score → accepted anyway, underconfident)
   *   signal=dismiss  + structural ≥ 0.5 → incorrect (high score → dismissed, overconfident)
   *   signal=dismiss  + structural < 0.5 → correct (low score → dismissed)
   *   signal=escalate + structural < 0.5 → correct (low score → escalated, was underscored)
   *   signal=escalate + structural ≥ 0.5 → incorrect (high score → escalated? unusual)
   *   signal=override → EXCLUDED (bypass, not a judgement on structural)
   */
  structuralPrecision(window: PrecisionWindow = {}): PrecisionResult {
    return this.computeDirectionalPrecision(window, (e) => e.structuralScore);
  }

  llmPrecision(window: PrecisionWindow = {}): PrecisionResult {
    return this.computeDirectionalPrecision(window, (e) => e.llmScore);
  }

  /**
   * Categories with the highest false-positive rates — i.e. where
   * `dismiss` signals dominate `accept`. Phase 3 calibration
   * (AISDLC-66) should prioritise tuning these.
   */
  highFalsePositiveCategories(
    window: PrecisionWindow = {},
    minSampleSize = 3,
  ): CategoryFalsePositive[] {
    const events = this.list(window).filter((e) => e.category);
    const grouped = new Map<string, { accept: number; dismiss: number }>();
    for (const e of events) {
      const key = e.category as string;
      const bucket = grouped.get(key) ?? { accept: 0, dismiss: 0 };
      if (e.signal === 'accept') bucket.accept++;
      else if (e.signal === 'dismiss') bucket.dismiss++;
      grouped.set(key, bucket);
    }
    const rows: CategoryFalsePositive[] = [];
    for (const [category, counts] of grouped) {
      const sampleSize = counts.accept + counts.dismiss;
      if (sampleSize < minSampleSize) continue;
      rows.push({
        category,
        sampleSize,
        falsePositiveCount: counts.dismiss,
        falsePositiveRate: sampleSize === 0 ? 0 : counts.dismiss / sampleSize,
      });
    }
    rows.sort((a, b) => b.falsePositiveRate - a.falsePositiveRate);
    return rows;
  }

  private computeDirectionalPrecision(
    window: PrecisionWindow,
    scoreOf: (e: DidFeedbackEventRecord) => number | undefined,
  ): PrecisionResult {
    const events = this.list(window);
    let sampleSize = 0;
    let correct = 0;
    for (const e of events) {
      if (e.signal === 'override') continue;
      const score = scoreOf(e);
      if (score === undefined) continue;
      sampleSize++;
      const high = score >= HIGH_SCORE_THRESHOLD;
      const directionallyCorrect =
        (e.signal === 'accept' && high) ||
        (e.signal === 'dismiss' && !high) ||
        (e.signal === 'escalate' && !high);
      if (directionallyCorrect) correct++;
    }
    return {
      sampleSize,
      correct,
      precision: sampleSize === 0 ? 0 : correct / sampleSize,
    };
  }
}

// ── Signal classification ────────────────────────────────────────────

const SA_LABELS: Readonly<Record<string, FeedbackSignal>> = Object.freeze({
  'sa/accept': 'accept',
  'sa/dismiss': 'dismiss',
  'sa/escalate': 'escalate',
});

/**
 * Map a GitHub label addition event to a feedback signal, or
 * undefined if the label isn't one of our SA signals.
 */
export function classifyLabel(label: string): FeedbackSignal | undefined {
  return SA_LABELS[label.toLowerCase()];
}

export const SA_FEEDBACK_LABELS: readonly string[] = Object.freeze([
  'sa/accept',
  'sa/dismiss',
  'sa/escalate',
]);

// ── Override auto-emit ───────────────────────────────────────────────

export interface OverrideFeedbackInput {
  didName: string;
  issueNumber: number;
  /** The override reason from `PriorityScore.override.reason`. */
  reason?: string;
  /** Principal who invoked the override, if known. */
  principal?: string;
}

/**
 * Emit an `override` feedback row when an admission score carries an
 * `override` bypass. Safe no-op when `override` is undefined — callers
 * can invoke unconditionally.
 */
export function recordOverrideFeedback(
  feedback: SAFeedbackStore,
  override: { reason?: string } | undefined,
  context: OverrideFeedbackInput,
): void {
  if (!override) return;
  feedback.record({
    didName: context.didName,
    issueNumber: context.issueNumber,
    // Override is a bypass of the whole SA score; by convention we
    // record against SA-1 (the dimension that gates admission).
    dimension: 'SA-1',
    signal: 'override',
    principal: context.principal,
    notes: override.reason ?? context.reason,
  });
}
