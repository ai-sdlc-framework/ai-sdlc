/**
 * Per-org calibration.yaml configuration for RFC-0031 DIDRevisionProposal
 * mechanism (Refit AISDLC-310).
 *
 * Exposes OQ-12.1 (confidence thresholds) and OQ-12.5 (rejection weights +
 * penalty floor) as per-org configurable values. Defaults match the values
 * shipped by AISDLC-271 / PR #476 and operator-affirmed during the 2026-05-16
 * audit (RFC-0031 §12.1 + §12.5 resolutions).
 *
 * Usage:
 *   1. Load the `.ai-sdlc/calibration.yaml` file.
 *   2. Call `parseRevisionProposalCalibrationYaml(content)` — validates +
 *      returns a fully-resolved config with all defaults filled in.
 *   3. Pass the resolved config to `computeConfidence()`,
 *      `recordRejection()`, and `computeRejectionPrecedentFactor()`.
 *
 * Validation rules (enforced at load time):
 *   - `highSampleSize > lowSampleSize > 0`
 *   - All weights in `[0, 1]`
 *   - `confidencePenaltyFloor` in `[0, 1]`
 */

import { parse as parseYaml } from 'yaml';

// ── Default constants ─────────────────────────────────────────────────

/** Minimum total signals (dismiss + escalate + drift) for HIGH confidence. */
export const DEFAULT_CONFIDENCE_HIGH_SAMPLE_SIZE = 20;

/** Below this total signal count the proposal is LOW confidence. */
export const DEFAULT_CONFIDENCE_LOW_SAMPLE_SIZE = 5;

/** Rejection precedent weight applied when the rejected proposal had HIGH confidence. */
export const DEFAULT_REJECTION_WEIGHT_HIGH = 0.8;

/** Rejection precedent weight applied when the rejected proposal had MEDIUM confidence. */
export const DEFAULT_REJECTION_WEIGHT_MEDIUM = 0.5;

/** Rejection precedent weight applied when the rejected proposal had LOW confidence. */
export const DEFAULT_REJECTION_WEIGHT_LOW = 0.2;

/**
 * Minimum value for the rejection precedent factor.
 * 0.2 = at most 80% suppression of future proposal confidence.
 */
export const DEFAULT_CONFIDENCE_PENALTY_FLOOR = 0.2;

// ── Type definitions ──────────────────────────────────────────────────

/**
 * Confidence threshold configuration (OQ-12.1).
 *
 * Sample size = `dismissSignals + escalateSignals + driftEvents`.
 */
export interface ConfidenceThresholdsConfig {
  /**
   * Total signal count ≥ this value contributes toward HIGH confidence
   * (alongside non-ambiguous classification and `evolving` identityClass).
   *
   * @default 20
   */
  highSampleSize: number;
  /**
   * Total signal count < this value forces LOW confidence.
   *
   * Must be < `highSampleSize`.
   * @default 5
   */
  lowSampleSize: number;
}

/**
 * Rejection precedent weights (OQ-12.5).
 *
 * These weights are stored on each `ProposalRejectionRecord` and averaged
 * by `computeRejectionPrecedentFactor()` to suppress future proposal
 * confidence for repeatedly-rejected fields.
 */
export interface RejectionPrecedentWeightsConfig {
  /**
   * Weight when the rejected proposal had HIGH confidence.
   * Higher weight = stronger suppression of future proposals.
   * @default 0.8
   */
  highConfidenceRejection: number;
  /**
   * Weight when the rejected proposal had MEDIUM confidence.
   * @default 0.5
   */
  mediumConfidenceRejection: number;
  /**
   * Weight when the rejected proposal had LOW confidence.
   * @default 0.2
   */
  lowConfidenceRejection: number;
}

/**
 * Rejection precedent configuration block (OQ-12.5).
 */
export interface RejectionPrecedentConfig {
  weights: RejectionPrecedentWeightsConfig;
  /**
   * Minimum value returned by `computeRejectionPrecedentFactor()`.
   * Prevents the precedent factor from suppressing proposals entirely.
   *
   * Formula: `factor = max(confidencePenaltyFloor, 1.0 - avgWeight × 0.5)`
   * @default 0.2
   */
  confidencePenaltyFloor: number;
}

/**
 * Raw (partial) calibration config shape as it appears in `calibration.yaml`.
 * All fields are optional; missing values fall back to defaults.
 */
export interface RevisionProposalCalibrationConfig {
  /** Fields that should never receive auto-proposals (OQ-12.3 — existing). */
  lockNoProposal?: string[];
  /** Override confidence thresholds (OQ-12.1). */
  confidenceThresholds?: Partial<ConfidenceThresholdsConfig>;
  /** Override rejection precedent weights + floor (OQ-12.5). */
  rejectionPrecedent?: {
    weights?: Partial<RejectionPrecedentWeightsConfig>;
    confidencePenaltyFloor?: number;
  };
}

/**
 * Fully-resolved calibration config — all optional fields replaced with
 * defaults. This is the shape passed to the revision-proposal functions.
 */
export interface ResolvedRevisionProposalCalibrationConfig {
  lockNoProposal: string[];
  confidenceThresholds: ConfidenceThresholdsConfig;
  rejectionPrecedent: RejectionPrecedentConfig;
}

/** The compile-time default resolved config (shipped AISDLC-271 values). */
export const DEFAULT_RESOLVED_CALIBRATION_CONFIG: ResolvedRevisionProposalCalibrationConfig = {
  lockNoProposal: [],
  confidenceThresholds: {
    highSampleSize: DEFAULT_CONFIDENCE_HIGH_SAMPLE_SIZE,
    lowSampleSize: DEFAULT_CONFIDENCE_LOW_SAMPLE_SIZE,
  },
  rejectionPrecedent: {
    weights: {
      highConfidenceRejection: DEFAULT_REJECTION_WEIGHT_HIGH,
      mediumConfidenceRejection: DEFAULT_REJECTION_WEIGHT_MEDIUM,
      lowConfidenceRejection: DEFAULT_REJECTION_WEIGHT_LOW,
    },
    confidencePenaltyFloor: DEFAULT_CONFIDENCE_PENALTY_FLOOR,
  },
};

// ── Validation ────────────────────────────────────────────────────────

export interface ConfigValidationError {
  field: string;
  message: string;
}

export type ConfigValidationResult =
  | { valid: true }
  | { valid: false; errors: ConfigValidationError[] };

/**
 * Validate a partial calibration config against the RFC-0031 §12.6 rules.
 *
 * Rules:
 *   - `highSampleSize > lowSampleSize > 0`
 *   - all weights in `[0, 1]`
 *   - `confidencePenaltyFloor` in `[0, 1]`
 *
 * Missing fields default to the shipped values and are not validated
 * (a partial config that omits a field is always valid for that field).
 */
export function validateRevisionProposalCalibrationConfig(
  config: RevisionProposalCalibrationConfig,
): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];

  // ── Confidence thresholds ────────────────────────────────────────
  const thresholds = config.confidenceThresholds;
  if (thresholds !== undefined) {
    const high = thresholds.highSampleSize ?? DEFAULT_CONFIDENCE_HIGH_SAMPLE_SIZE;
    const low = thresholds.lowSampleSize ?? DEFAULT_CONFIDENCE_LOW_SAMPLE_SIZE;

    if (thresholds.lowSampleSize !== undefined && thresholds.lowSampleSize <= 0) {
      errors.push({
        field: 'confidenceThresholds.lowSampleSize',
        message: `must be > 0 (got ${thresholds.lowSampleSize})`,
      });
    }
    if (thresholds.highSampleSize !== undefined && thresholds.highSampleSize <= 0) {
      errors.push({
        field: 'confidenceThresholds.highSampleSize',
        message: `must be > 0 (got ${thresholds.highSampleSize})`,
      });
    }
    // highSampleSize must be strictly greater than lowSampleSize
    if (high <= low) {
      errors.push({
        field: 'confidenceThresholds',
        message: `highSampleSize (${high}) must be > lowSampleSize (${low})`,
      });
    }
  }

  // ── Rejection precedent ──────────────────────────────────────────
  const rp = config.rejectionPrecedent;
  if (rp !== undefined) {
    const weights = rp.weights;
    if (weights !== undefined) {
      const weightFields: Array<[keyof RejectionPrecedentWeightsConfig, number | undefined]> = [
        ['highConfidenceRejection', weights.highConfidenceRejection],
        ['mediumConfidenceRejection', weights.mediumConfidenceRejection],
        ['lowConfidenceRejection', weights.lowConfidenceRejection],
      ];
      for (const [key, value] of weightFields) {
        if (value !== undefined && (value < 0 || value > 1)) {
          errors.push({
            field: `rejectionPrecedent.weights.${key}`,
            message: `must be in [0, 1] (got ${value})`,
          });
        }
      }
    }

    if (
      rp.confidencePenaltyFloor !== undefined &&
      (rp.confidencePenaltyFloor < 0 || rp.confidencePenaltyFloor > 1)
    ) {
      errors.push({
        field: 'rejectionPrecedent.confidencePenaltyFloor',
        message: `must be in [0, 1] (got ${rp.confidencePenaltyFloor})`,
      });
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true };
}

// ── Resolution (merge partial config with defaults) ───────────────────

/**
 * Merge a partial `RevisionProposalCalibrationConfig` with defaults to
 * produce a fully-resolved config. Does NOT validate — call
 * `validateRevisionProposalCalibrationConfig()` first if you need to
 * surface errors to the operator.
 */
export function resolveRevisionProposalCalibrationConfig(
  config: RevisionProposalCalibrationConfig = {},
): ResolvedRevisionProposalCalibrationConfig {
  const d = DEFAULT_RESOLVED_CALIBRATION_CONFIG;
  return {
    lockNoProposal: config.lockNoProposal ?? d.lockNoProposal,
    confidenceThresholds: {
      highSampleSize:
        config.confidenceThresholds?.highSampleSize ?? d.confidenceThresholds.highSampleSize,
      lowSampleSize:
        config.confidenceThresholds?.lowSampleSize ?? d.confidenceThresholds.lowSampleSize,
    },
    rejectionPrecedent: {
      weights: {
        highConfidenceRejection:
          config.rejectionPrecedent?.weights?.highConfidenceRejection ??
          d.rejectionPrecedent.weights.highConfidenceRejection,
        mediumConfidenceRejection:
          config.rejectionPrecedent?.weights?.mediumConfidenceRejection ??
          d.rejectionPrecedent.weights.mediumConfidenceRejection,
        lowConfidenceRejection:
          config.rejectionPrecedent?.weights?.lowConfidenceRejection ??
          d.rejectionPrecedent.weights.lowConfidenceRejection,
      },
      confidencePenaltyFloor:
        config.rejectionPrecedent?.confidencePenaltyFloor ??
        d.rejectionPrecedent.confidencePenaltyFloor,
    },
  };
}

// ── YAML loading ──────────────────────────────────────────────────────

/**
 * Parse and validate a `.ai-sdlc/calibration.yaml` file's content.
 *
 * Expected top-level shape:
 * ```yaml
 * calibration:
 *   lockNoProposal: [...]
 *   confidenceThresholds:
 *     highSampleSize: 20
 *     lowSampleSize: 5
 *   rejectionPrecedent:
 *     weights:
 *       highConfidenceRejection: 0.8
 *       mediumConfidenceRejection: 0.5
 *       lowConfidenceRejection: 0.2
 *     confidencePenaltyFloor: 0.2
 * ```
 *
 * Missing fields are filled with defaults. Validation failures throw with
 * a descriptive message listing all constraint violations.
 *
 * @param yamlContent Raw UTF-8 content of `calibration.yaml`.
 * @returns Fully-resolved config ready to pass to revision-proposal functions.
 * @throws {Error} When the YAML fails RFC-0031 §12.6 validation rules.
 */
export function parseRevisionProposalCalibrationYaml(
  yamlContent: string,
): ResolvedRevisionProposalCalibrationConfig {
  const doc = parseYaml(yamlContent) as Record<string, unknown> | null;
  const raw = (doc?.calibration ?? {}) as RevisionProposalCalibrationConfig;

  const config: RevisionProposalCalibrationConfig = {
    lockNoProposal: Array.isArray(raw.lockNoProposal) ? raw.lockNoProposal : undefined,
    confidenceThresholds:
      raw.confidenceThresholds !== null && typeof raw.confidenceThresholds === 'object'
        ? (raw.confidenceThresholds as Partial<ConfidenceThresholdsConfig>)
        : undefined,
    rejectionPrecedent:
      raw.rejectionPrecedent !== null && typeof raw.rejectionPrecedent === 'object'
        ? (raw.rejectionPrecedent as RevisionProposalCalibrationConfig['rejectionPrecedent'])
        : undefined,
  };

  const validation = validateRevisionProposalCalibrationConfig(config);
  if (!validation.valid) {
    const lines = validation.errors.map((e) => `  ${e.field}: ${e.message}`).join('\n');
    throw new Error(`calibration.yaml validation failed (RFC-0031 §12.6):\n${lines}`);
  }

  return resolveRevisionProposalCalibrationConfig(config);
}
