/**
 * Phase 3 weight auto-calibration (RFC-0008 Addendum B §B.8).
 *
 * Reads trailing-90-day precision from `SAFeedbackStore`, shifts the
 * Phase 3 (w_structural, w_llm) pair in the direction of the better-
 * performing layer, and persists the result to `sa_phase_weights`.
 *
 * CR-2: `w_structural ≥ 0.20` floor enforced on the output, as is a
 * symmetric `w_llm ≥ 0.20` floor — extreme single-layer dominance is
 * never written.
 *
 * Idempotent: if the computed weights round-trip to the currently
 * persisted pair, the row is not written and the caller's diff is
 * empty. Rolling 90-day window by default.
 */

import type { SaDimension } from '../state/types.js';
import type { StateStore } from '../state/store.js';
import type { SAFeedbackStore } from './feedback-store.js';
import type { PhaseWeights } from './composite.js';
import { W_STRUCTURAL_FLOOR } from './composite.js';

// ── Defaults and constants ──────────────────────────────────────────

export const WEIGHT_FLOOR = W_STRUCTURAL_FLOOR; // 0.20
export const WEIGHT_CEILING = 1 - WEIGHT_FLOOR; // 0.80
export const DEFAULT_SHIFT_SIZE = 0.05;
export const PRECISION_DELTA_THRESHOLD = 0.1;
/** Default calibration window — 90 days. */
export const DEFAULT_WINDOW_DAYS = 90;
/** Phase 2c default weights — used as starting point if none persisted. */
export const DEFAULT_STARTING_WEIGHTS: PhaseWeights = Object.freeze({
  wStructural: 0.35,
  wLlm: 0.65,
}) as PhaseWeights;

// ── Pure compute ────────────────────────────────────────────────────

export interface PrecisionPair {
  structural: number;
  llm: number;
}

export interface CalibrationDecision {
  /** 'toward-structural' | 'toward-llm' | 'hold' */
  direction: 'toward-structural' | 'toward-llm' | 'hold';
  /** Magnitude of the LLM−structural precision difference. */
  delta: number;
}

export function decideCalibrationDirection(precision: PrecisionPair): CalibrationDecision {
  const delta = precision.llm - precision.structural;
  if (delta > PRECISION_DELTA_THRESHOLD) return { direction: 'toward-llm', delta };
  if (delta < -PRECISION_DELTA_THRESHOLD) return { direction: 'toward-structural', delta };
  return { direction: 'hold', delta };
}

export interface ComputePhase3WeightsInput {
  current: PhaseWeights;
  precision: PrecisionPair;
  shiftSize?: number;
}

export function computePhase3Weights(input: ComputePhase3WeightsInput): PhaseWeights {
  const shift = input.shiftSize ?? DEFAULT_SHIFT_SIZE;
  const decision = decideCalibrationDirection(input.precision);
  let wStructural = input.current.wStructural;
  if (decision.direction === 'toward-llm') wStructural -= shift;
  else if (decision.direction === 'toward-structural') wStructural += shift;
  wStructural = Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEILING, wStructural));
  return { wStructural, wLlm: 1 - wStructural };
}

// ── Orchestrator ────────────────────────────────────────────────────

export interface AutoCalibrateDeps {
  feedback: SAFeedbackStore;
  stateStore: StateStore;
  /** Clock injection for deterministic tests. */
  now?: () => number;
  /** Override the window (default 90d). */
  windowDays?: number;
  /** Starting weights when none are persisted. */
  startingWeights?: PhaseWeights;
  /** Adjustment step size per calibration run. */
  shiftSize?: number;
}

export interface DimensionDiff {
  dimension: SaDimension;
  precision: PrecisionPair;
  previous: PhaseWeights;
  next: PhaseWeights;
  changed: boolean;
}

export interface AutoCalibrateResult {
  diffs: DimensionDiff[];
}

export async function autoCalibratePhaseWeights(
  deps: AutoCalibrateDeps,
): Promise<AutoCalibrateResult> {
  const nowMs = (deps.now ?? (() => Date.now()))();
  const windowDays = deps.windowDays ?? DEFAULT_WINDOW_DAYS;
  const since = new Date(nowMs - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const startingWeights = deps.startingWeights ?? DEFAULT_STARTING_WEIGHTS;

  const diffs: DimensionDiff[] = [];
  for (const dimension of ['SA-1', 'SA-2'] as const) {
    const existing = deps.stateStore.getSaPhaseWeights(dimension);
    const current: PhaseWeights = existing
      ? { wStructural: existing.wStructural, wLlm: existing.wLlm }
      : startingWeights;

    const structural = deps.feedback.structuralPrecision({ dimension, since });
    const llm = deps.feedback.llmPrecision({ dimension, since });
    const precision: PrecisionPair = {
      structural: structural.precision,
      llm: llm.precision,
    };

    const next = computePhase3Weights({
      current,
      precision,
      shiftSize: deps.shiftSize,
    });

    const changed = !weightsEqual(current, next) || !existing; /* first-run write */

    if (changed) {
      deps.stateStore.upsertSaPhaseWeights({
        dimension,
        wStructural: next.wStructural,
        wLlm: next.wLlm,
      });
    }

    diffs.push({
      dimension,
      precision,
      previous: current,
      next,
      // `changed` here reflects whether the weight pair shifted (ignoring
      // first-run writes, which always persist to initialise the table).
      changed: !weightsEqual(current, next),
    });
  }

  return { diffs };
}

function weightsEqual(a: PhaseWeights, b: PhaseWeights): boolean {
  return Math.abs(a.wStructural - b.wStructural) < 1e-9 && Math.abs(a.wLlm - b.wLlm) < 1e-9;
}

// ── Diff rendering (for CLI) ─────────────────────────────────────────

export function renderCalibrationDiff(result: AutoCalibrateResult): string {
  const lines: string[] = [];
  lines.push('SA phase-weight calibration diff');
  lines.push('--------------------------------');
  for (const d of result.diffs) {
    lines.push(`${d.dimension}:`);
    lines.push(
      `  previous : w_structural=${d.previous.wStructural.toFixed(3)}  w_llm=${d.previous.wLlm.toFixed(3)}`,
    );
    lines.push(
      `  next     : w_structural=${d.next.wStructural.toFixed(3)}  w_llm=${d.next.wLlm.toFixed(3)}`,
    );
    lines.push(
      `  precision: structural=${(d.precision.structural * 100).toFixed(1)}%  llm=${(d.precision.llm * 100).toFixed(1)}%`,
    );
    lines.push(`  changed  : ${d.changed ? 'yes' : 'no'}`);
  }
  return lines.join('\n');
}
