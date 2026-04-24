/**
 * Admission-specific Human Curve composite (RFC-0008 §A.6, Amendment 4).
 *
 * The admission HC differs from the legacy PPA HC in two ways:
 *   1. Four terms instead of three — HC_design enters at 0.10 weight.
 *   2. Weights are (0.2, 0.45, 0.25, 0.10) rather than (0.5, 0.3, 0.2).
 *
 * HC_design flows through tanh alongside the other three components;
 * it is NOT a direct soul-alignment modifier (Amendment 5 correction
 * to the v3 draft).
 *
 * The `override` bypass on `PriorityInput` is still position-1: this
 * module never runs when an override is active — the admission
 * composite (AISDLC-48) short-circuits on override before calling
 * `computeAdmissionHumanCurve`.
 */

import type {
  AdmissionInput,
  AuthorAssociation,
  DesignAuthoritySignal,
} from './admission-score.js';
import { computeDesignAuthorityWeight } from './admission-enrichment.js';

/**
 * Fixed §A.6 weights. Exposed for validation and for downstream callers
 * that need to introspect the HC decomposition.
 */
export const HC_WEIGHTS = Object.freeze({
  explicit: 0.2,
  consensus: 0.45,
  decision: 0.25,
  design: 0.1,
});

/** Sum of HC_WEIGHTS — must equal 1.0 exactly (AC #2). */
export const HC_WEIGHT_SUM =
  HC_WEIGHTS.explicit + HC_WEIGHTS.consensus + HC_WEIGHTS.decision + HC_WEIGHTS.design;

export interface AdmissionHumanCurveResult {
  /** Signed explicit-priority signal in [-1, 1]. */
  hcExplicit: number;
  /** Signed consensus signal in [-1, 1]. */
  hcConsensus: number;
  /** Signed meeting-decision signal in [-1, 1] (0 = neutral when absent). */
  hcDecision: number;
  /** Signed design-authority signal in [-1, 1]. */
  hcDesign: number;
  /** Weighted sum before tanh. */
  hcRaw: number;
  /** `tanh(hcRaw)` — the HC value consumed by the admission composite. */
  hcComposite: number;
}

const TRUSTED_ASSOCIATIONS = new Set<AuthorAssociation>(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function deriveHcExplicit(input: Pick<AdmissionInput, 'labels'>): number {
  const labels = input.labels;
  if (labels.includes('high') || labels.includes('P0') || labels.includes('critical')) {
    return 1.0;
  }
  if (labels.includes('low') || labels.includes('backlog')) return -1.0;
  return 0;
}

export function deriveHcConsensus(
  input: Pick<AdmissionInput, 'reactionCount' | 'authorAssociation'>,
): number {
  const isTrusted = TRUSTED_ASSOCIATIONS.has(input.authorAssociation ?? 'NONE');
  const reactionConsensus = Math.min(1, input.reactionCount / 5);
  // Trusted authors carry implicit team consensus — floor at 0.5 before centering.
  const base = isTrusted ? Math.max(0.5, reactionConsensus) : reactionConsensus;
  // [0, 1] → [-1, 1]
  return base * 2 - 1;
}

/**
 * HC_decision — meeting-decision signal in [-1, 1].
 *
 * AdmissionInput has no dedicated meeting-decision field. We return
 * neutral (0) by default. Callers that later add a GitHub-comment
 * parser for `/decide approve` / `/decide reject` can plumb it through
 * via an optional AdmissionInput field without breaking this shape.
 */
export function deriveHcDecision(_input: AdmissionInput): number {
  return 0;
}

export function deriveHcDesign(signal: DesignAuthoritySignal | undefined): number {
  const raw = computeDesignAuthorityWeight(signal);
  return clamp(raw, -1, 1);
}

/**
 * Compute the admission HC composite from an `AdmissionInput`.
 * Returns both the weighted pre-tanh sum and the tanh-compressed value
 * for auditability.
 */
export function computeAdmissionHumanCurve(input: AdmissionInput): AdmissionHumanCurveResult {
  const hcExplicit = deriveHcExplicit(input);
  const hcConsensus = deriveHcConsensus(input);
  const hcDecision = deriveHcDecision(input);
  const hcDesign = deriveHcDesign(input.designAuthoritySignal);

  const hcRaw =
    HC_WEIGHTS.explicit * hcExplicit +
    HC_WEIGHTS.consensus * hcConsensus +
    HC_WEIGHTS.decision * hcDecision +
    HC_WEIGHTS.design * hcDesign;
  const hcComposite = Math.tanh(hcRaw);

  return { hcExplicit, hcConsensus, hcDecision, hcDesign, hcRaw, hcComposite };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
