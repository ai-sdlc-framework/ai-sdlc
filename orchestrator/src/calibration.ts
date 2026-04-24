/**
 * C6 — Category-scoped calibration (RFC-0008 §10 Amendment 6).
 *
 * Replaces PPA v1.0's scalar calibrationCoefficient with per-category
 * coefficients derived from feedback signals. Categories are
 * PillarContribution labels (product / design / engineering) or
 * arbitrary labels the caller chooses.
 *
 *   Cκ_category = clamp([0.7, 1.3], 1.0 + (accepts - escalates) / max(1, total) × 0.3)
 *
 * Per v1.1 note: this adjusts the multiplicative Cκ term, NOT SA-2
 * directly. Per-dimension calibration lands in PPA v1.1 §17.
 */

import type { SaDimension } from './state/types.js';
import type { PrecisionWindow } from './sa-scoring/feedback-store.js';
import type { SAFeedbackStore } from './sa-scoring/feedback-store.js';

export const CALIBRATION_MIN = 0.7;
export const CALIBRATION_MAX = 1.3;
/** Slope of the feedback-driven adjustment. Spec §10 uses 0.3. */
export const CALIBRATION_SLOPE = 0.3;

export interface CategoryFeedback {
  accepts: number;
  dismisses: number;
  escalates: number;
  overrides?: number;
}

export function computeCalibrationCoefficient(feedback: CategoryFeedback): number {
  const total = feedback.accepts + feedback.dismisses + feedback.escalates;
  if (total === 0) return 1.0;
  const delta = (feedback.accepts - feedback.escalates) / Math.max(1, total);
  return clamp(1.0 + delta * CALIBRATION_SLOPE, CALIBRATION_MIN, CALIBRATION_MAX);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ── Bulk aggregation from SAFeedbackStore ────────────────────────────

export interface BuildCategoryCoefficientsInput {
  /** Which SA dimension to pull feedback from. Defaults to SA-1. */
  dimension?: SaDimension;
  /** Trailing-window filter. */
  since?: string;
  /** Categories to evaluate; when absent, uses all seen in the window. */
  categories?: readonly string[];
  /** Minimum feedback count per category before returning a coefficient. */
  minSampleSize?: number;
}

/**
 * Aggregate feedback rows by category and return `{category: coefficient}`.
 * Categories with fewer than `minSampleSize` samples are omitted — the
 * scalar fallback applies to them.
 */
export function buildCategoryCoefficients(
  feedback: SAFeedbackStore,
  input: BuildCategoryCoefficientsInput = {},
): Record<string, number> {
  const window: PrecisionWindow = {
    dimension: input.dimension,
    since: input.since,
  };
  const events = feedback.list(window).filter((e) => e.category);
  const buckets = new Map<string, CategoryFeedback>();
  for (const e of events) {
    const key = e.category as string;
    if (input.categories && !input.categories.includes(key)) continue;
    const current = buckets.get(key) ?? {
      accepts: 0,
      dismisses: 0,
      escalates: 0,
      overrides: 0,
    };
    switch (e.signal) {
      case 'accept':
        current.accepts++;
        break;
      case 'dismiss':
        current.dismisses++;
        break;
      case 'escalate':
        current.escalates++;
        break;
      case 'override':
        current.overrides = (current.overrides ?? 0) + 1;
        break;
    }
    buckets.set(key, current);
  }

  const minSize = input.minSampleSize ?? 1;
  const result: Record<string, number> = {};
  for (const [category, f] of buckets) {
    const samples = f.accepts + f.dismisses + f.escalates;
    if (samples < minSize) continue;
    result[category] = computeCalibrationCoefficient(f);
  }
  return result;
}
