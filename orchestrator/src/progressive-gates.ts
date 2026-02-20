/**
 * Progressive gate adjustment — adapts gate enforcement and thresholds
 * based on codebase complexity score.
 *
 * RFC reference: Lines 217-228 (progressive gate matrix).
 */

import type { Gate, EnforcementLevel } from '@ai-sdlc/reference';
import { PROGRESSIVE_GATE_PROFILES, type ComplexityBand, type GateProfile } from './defaults.js';
import type { StateStore } from './state/store.js';
import type { GateThresholdOverride } from './state/types.js';

export interface AdjustedGate extends Gate {
  originalEnforcement: EnforcementLevel;
  complexityBand: ComplexityBand;
  adjustedThresholds?: Record<string, unknown>;
}

export interface GateAdjustment {
  gateName: string;
  originalEnforcement: EnforcementLevel;
  adjustedEnforcement: EnforcementLevel;
  band: ComplexityBand;
  thresholdChanges: Record<string, unknown>;
}

/**
 * Determine the complexity band for a given score (1-10).
 */
export function getComplexityBand(score: number): ComplexityBand {
  const clamped = Math.max(1, Math.min(10, Math.round(score)));
  for (const profile of PROGRESSIVE_GATE_PROFILES) {
    if (clamped >= profile.minScore && clamped <= profile.maxScore) {
      return profile.band;
    }
  }
  return 'standard';
}

/**
 * Get the gate profile for a given complexity score.
 */
export function getGateProfile(score: number): GateProfile {
  const band = getComplexityBand(score);
  return PROGRESSIVE_GATE_PROFILES.find((p) => p.band === band) ?? PROGRESSIVE_GATE_PROFILES[1];
}

/**
 * Map an enforcement level string to an ordered numeric value for comparison.
 */
function enforcementOrd(level: EnforcementLevel): number {
  switch (level) {
    case 'advisory':
      return 0;
    case 'soft-mandatory':
      return 1;
    case 'hard-mandatory':
      return 2;
    default:
      return 1;
  }
}

/**
 * Determine the adjusted enforcement level for a gate given a complexity band.
 * Rules:
 * - Trivial band: enforcement can be relaxed (hard-mandatory -> soft-mandatory, soft-mandatory -> advisory)
 * - Standard band: no change
 * - Complex/critical bands: enforcement is tightened (advisory -> soft-mandatory, soft-mandatory -> hard-mandatory)
 */
export function adjustEnforcement(
  original: EnforcementLevel,
  band: ComplexityBand,
): EnforcementLevel {
  const ord = enforcementOrd(original);

  switch (band) {
    case 'trivial': {
      // Relax by one level, floor at advisory
      const newOrd = Math.max(0, ord - 1);
      return (['advisory', 'soft-mandatory', 'hard-mandatory'] as const)[newOrd];
    }
    case 'standard':
      return original;
    case 'complex':
    case 'critical': {
      // Tighten by one level, cap at hard-mandatory
      const newOrd = Math.min(2, ord + 1);
      return (['advisory', 'soft-mandatory', 'hard-mandatory'] as const)[newOrd];
    }
    default:
      return original;
  }
}

/**
 * Build threshold adjustments for a gate based on the profile.
 */
function buildThresholdAdjustments(profile: GateProfile): Record<string, unknown> {
  return {
    testCoverageThreshold: profile.testCoverageThreshold,
    reviewRequired: profile.reviewRequired,
    securityScanRequired: profile.securityScanRequired,
    documentationRequired: profile.documentationRequired,
  };
}

/**
 * Adjust a single gate for the given complexity score.
 * Applies profile-based enforcement adjustment and threshold overrides.
 */
export function adjustGateForComplexity(
  score: number,
  gate: Gate,
  overrides?: GateThresholdOverride[],
): AdjustedGate {
  const profile = getGateProfile(score);
  const band = profile.band;

  // Check for DB override first
  const override = overrides?.find((o) => o.gateName === gate.name && o.complexityBand === band);

  let adjustedEnforcement: EnforcementLevel;
  let adjustedThresholds: Record<string, unknown>;

  if (override) {
    adjustedEnforcement = override.enforcementLevel as EnforcementLevel;
    adjustedThresholds = override.thresholdOverrides
      ? JSON.parse(override.thresholdOverrides)
      : buildThresholdAdjustments(profile);
  } else {
    adjustedEnforcement = adjustEnforcement(gate.enforcement, band);
    adjustedThresholds = buildThresholdAdjustments(profile);
  }

  return {
    ...gate,
    enforcement: adjustedEnforcement,
    originalEnforcement: gate.enforcement,
    complexityBand: band,
    adjustedThresholds,
  };
}

/**
 * Adjust all gates for the given complexity score.
 * Optionally loads overrides from the state store.
 */
export function adjustGatesForComplexity(
  score: number,
  gates: Gate[],
  store?: StateStore,
): AdjustedGate[] {
  const band = getComplexityBand(score);
  const overrides = store?.getGateThresholdOverrides(undefined, band);
  return gates.map((gate) => adjustGateForComplexity(score, gate, overrides));
}

/**
 * Compute the set of adjustments that would be made to gates.
 * Useful for reporting/logging without mutating.
 */
export function computeGateAdjustments(score: number, gates: Gate[]): GateAdjustment[] {
  const profile = getGateProfile(score);
  return gates.map((gate) => {
    const adjusted = adjustEnforcement(gate.enforcement, profile.band);
    return {
      gateName: gate.name,
      originalEnforcement: gate.enforcement,
      adjustedEnforcement: adjusted,
      band: profile.band,
      thresholdChanges: buildThresholdAdjustments(profile),
    };
  });
}
