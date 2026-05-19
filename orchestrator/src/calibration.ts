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
 *
 * RFC-0009 Phase 2.2 extension: `buildSoulCalibrationMatrix` aggregates
 * Cκ coefficients per-soul × per-dimension (N×M cells). Feedback events
 * tagged with a soul slug as their `category` and a SA dimension drive
 * the matrix cells. Souls × dimensions with insufficient data are omitted
 * from the matrix (callers fall back to the scalar coefficient or 1.0).
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

// ── RFC-0009 Phase 2.2 — Per-soul × per-dimension Cκ matrix ─────────

/**
 * Input options for `buildSoulCalibrationMatrix`.
 */
export interface BuildSoulCalibrationMatrixInput {
  /**
   * Soul slugs to include in the matrix (N axis).
   * Feedback events whose `category` matches a slug are collected.
   */
  souls: readonly string[];
  /**
   * SA dimensions to include in the matrix (M axis).
   * When absent, all SA dimensions are sampled.
   */
  dimensions?: readonly SaDimension[];
  /** Trailing-window filter (ISO timestamp). */
  since?: string;
  /**
   * Minimum feedback event count per (soul, dimension) cell before a
   * coefficient is emitted. Cells below this threshold are omitted from
   * the matrix — callers should fall back to 1.0 (neutral) for absent cells.
   */
  minSampleSize?: number;
}

/**
 * The N×M Cκ calibration matrix for a tessellated platform.
 *
 *   cells[soulSlug][dimension] = calibration coefficient in [0.7, 1.3]
 *
 * Cells omitted from the map have insufficient feedback data.
 * Callers treat absent cells as 1.0 (neutral, no calibration adjustment).
 */
export interface SoulCalibrationMatrix {
  /**
   * N×M map: `{ soulSlug: { saDimension: coefficient } }`.
   * Only cells with sufficient data are present.
   */
  cells: Record<string, Record<string, number>>;
  /**
   * Souls (N axis) included in this matrix — equal to `input.souls`.
   * Useful for distinguishing "soul has data but coefficient is neutral"
   * from "soul was not included in the query".
   */
  souls: readonly string[];
  /**
   * SA dimensions (M axis) sampled — equal to `input.dimensions` when
   * provided, or all dimensions found in the feedback window.
   */
  dimensions: readonly string[];
}

/** All recognized SA dimensions for default matrix columns. */
const ALL_SA_DIMENSIONS: readonly SaDimension[] = ['SA-1', 'SA-2'];

/**
 * Aggregate Cκ calibration coefficients per-soul × per-dimension (N×M cells).
 *
 * Feedback events tagged with:
 *   - `category = <soul-slug>` (identifies which soul the feedback is for)
 *   - `dimension = <SA-1 | SA-2>` (SA dimension the feedback applies to)
 *
 * ...drive the per-cell coefficient using the same formula as
 * `computeCalibrationCoefficient`.
 *
 * Usage in tessellated admission scoring (RFC-0009 §6):
 *   - Look up `matrix.cells[targetSoul][dimension]` for the effective Cκ
 *   - Fall back to 1.0 (neutral) when the cell is absent (insufficient data)
 *   - Cross-soul aggregate: apply `crossSoulScoringRule` over per-soul cells
 *
 * @example
 * ```ts
 * const matrix = buildSoulCalibrationMatrix(feedback, {
 *   souls: ['soul-a', 'soul-b', 'soul-c'],
 *   dimensions: ['SA-1', 'SA-2'],
 *   minSampleSize: 5,
 * });
 * const ckSoulA = matrix.cells['soul-a']?.['SA-1'] ?? 1.0;
 * ```
 */
export function buildSoulCalibrationMatrix(
  feedback: SAFeedbackStore,
  input: BuildSoulCalibrationMatrixInput,
): SoulCalibrationMatrix {
  const dims: readonly SaDimension[] = input.dimensions ?? ALL_SA_DIMENSIONS;
  const cells: Record<string, Record<string, number>> = {};

  for (const soul of input.souls) {
    const soulCells: Record<string, number> = {};

    for (const dim of dims) {
      const window: PrecisionWindow = { dimension: dim, since: input.since };
      const events = feedback.list(window).filter((e) => e.category === soul);

      if (events.length === 0) continue;

      const bucket: CategoryFeedback = {
        accepts: 0,
        dismisses: 0,
        escalates: 0,
        overrides: 0,
      };
      for (const e of events) {
        switch (e.signal) {
          case 'accept':
            bucket.accepts++;
            break;
          case 'dismiss':
            bucket.dismisses++;
            break;
          case 'escalate':
            bucket.escalates++;
            break;
          case 'override':
            bucket.overrides = (bucket.overrides ?? 0) + 1;
            break;
        }
      }

      const sampleSize = bucket.accepts + bucket.dismisses + bucket.escalates;
      if (sampleSize < (input.minSampleSize ?? 1)) continue;

      soulCells[dim] = computeCalibrationCoefficient(bucket);
    }

    if (Object.keys(soulCells).length > 0) {
      cells[soul] = soulCells;
    }
  }

  return { cells, souls: input.souls, dimensions: dims };
}
