/**
 * SA-1 / SA-2 composite (RFC-0008 Addendum B §B.7).
 *
 * Combines Layer 1 deterministic results, Layer 2 BM25 structural
 * scores, and Layer 3 LLM structured assessments into the two
 * soul-alignment dimensions used by the admission composite.
 *
 * SA-1 per §B.7.1:
 *   hard gate: scopeGate core → SA-1 = 0.0 (STOP)
 *   coreConflictPenalty    = min(0.8, coreViolationCount × 0.4)
 *   evolvingConflictPenalty = min(0.3, evolvingViolationCount × 0.1)
 *   conflictPenalty        = 1.0 − coreConflictPenalty − evolvingConflictPenalty
 *   subtleMult             = 0.5 if any high-severity conflict, else 1.0
 *   blended                = w_s × domainRelevance + w_l × domainIntent × subtleMult
 *   SA-1                   = blended × conflictPenalty
 *
 * SA-2 per corrected §B.7.2 (CR-1 — no self-multiplication):
 *   computableScore       = 0.3 × tokenCompliance + 0.2 × catalogHealth
 *   designConflictPenalty = 1.0 − min(0.6, coreAp × 0.3 + evolvingAp × 0.1)
 *   llmTerm               = w_l × principleAlignment × subtleMult
 *   blendedScore          = w_s × principleCoverage + llmTerm
 *   llmComponent          = blendedScore × designConflictPenalty
 *   SA-2                  = computableScore + 0.5 × llmComponent
 *
 * Phase weights (§B.7.3):
 *   2a shadow      → (0, 0)      — computed but not used in ranking
 *   2b blended     → (0.20, 0.80)
 *   2c calibrating → (0.35, 0.65)
 *   3 calibrated   → flywheel-driven; w_structural floored at 0.20 (CR-2)
 */

import type { SubtleConflict, SubtleDesignConflict } from './layer3-llm.js';

// ── Phase config ─────────────────────────────────────────────────────

export type SaPhase = '2a' | '2b' | '2c' | '3';

export interface PhaseWeights {
  wStructural: number;
  wLlm: number;
}

/** CR-2: Phase 3 must never drop w_structural below this floor. */
export const W_STRUCTURAL_FLOOR = 0.2;

export function getPhaseWeights(phase: SaPhase, calibrated?: PhaseWeights): PhaseWeights {
  switch (phase) {
    case '2a':
      return { wStructural: 0, wLlm: 0 };
    case '2b':
      return { wStructural: 0.2, wLlm: 0.8 };
    case '2c':
      return { wStructural: 0.35, wLlm: 0.65 };
    case '3': {
      if (!calibrated) return { wStructural: 0.35, wLlm: 0.65 };
      const wStructural = Math.max(W_STRUCTURAL_FLOOR, calibrated.wStructural);
      // wLlm is whatever is left after clamping — keeps the pair summing to 1.0.
      const wLlm = Math.max(0, 1 - wStructural);
      return { wStructural, wLlm };
    }
  }
}

// ── Inputs ───────────────────────────────────────────────────────────

export interface Sa1Inputs {
  /** True when Layer 1 scope gate flagged a core out-of-scope hit. */
  hardGated: boolean;
  coreViolationCount: number;
  evolvingViolationCount: number;
  /** Layer 2 SA-1 domainRelevance in [0, 1]. */
  domainRelevance: number;
  /** Layer 3 SA-1 domainIntent in [0, 1] (already confidence-filtered). */
  domainIntent: number;
  /** Layer 3 SA-1 subtle conflicts (already confidence-filtered). */
  subtleConflicts: SubtleConflict[];
}

export interface Sa2Inputs {
  /** From DSB status, normalized to [0, 1]. */
  tokenCompliance: number;
  /** From DSB status, normalized to [0, 1]. */
  catalogHealth: number;
  /** Layer 2 SA-2 principleCoverage (weighted mean) in [0, 1]. */
  principleCoverage: number;
  /** Layer 3 SA-2 principleAlignment in [0, 1] (confidence-filtered). */
  principleAlignment: number;
  /** Count of core-classified design anti-pattern hits. */
  coreDesignAntiPatternCount: number;
  /** Count of evolving-classified design anti-pattern hits. */
  evolvingDesignAntiPatternCount: number;
  /** Layer 3 SA-2 subtle design conflicts (confidence-filtered). */
  subtleDesignConflicts: SubtleDesignConflict[];
}

// ── Outputs ──────────────────────────────────────────────────────────

export interface Sa1Result {
  sa1: number;
  hardGated: boolean;
  /** Structural contribution: w_s × domainRelevance. */
  structuralContribution: number;
  /** LLM contribution: w_l × domainIntent × subtleMult. */
  llmContribution: number;
  blended: number;
  conflictPenalty: number;
  subtleMult: number;
}

export interface Sa2Result {
  sa2: number;
  computableScore: number;
  structuralContribution: number;
  llmContribution: number;
  blendedScore: number;
  designConflictPenalty: number;
  subtleMult: number;
  llmComponent: number;
}

export interface SoulAlignmentResult {
  phase: SaPhase;
  weights: PhaseWeights;
  /** True for Phase 2a — consumers must NOT use sa1/sa2 in ranking. */
  shadowMode: boolean;
  sa1: Sa1Result;
  sa2: Sa2Result;
}

// ── Helpers ──────────────────────────────────────────────────────────

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function hasHighSeverity(conflicts: readonly { severity: string }[]): boolean {
  return conflicts.some((c) => c.severity === 'high');
}

function normalizeCoverage(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return 0;
  const clamped = value > 1 ? value / 100 : value;
  return clamp01(clamped);
}

// ── SA-1 ─────────────────────────────────────────────────────────────

export function computeSa1(inputs: Sa1Inputs, weights: PhaseWeights): Sa1Result {
  // Hard gate: core out-of-scope match forces SA-1 = 0 irrespective of
  // Layer 2/3 output (§B.7.1 STOP condition).
  if (inputs.hardGated) {
    return {
      sa1: 0,
      hardGated: true,
      structuralContribution: 0,
      llmContribution: 0,
      blended: 0,
      conflictPenalty: 0,
      subtleMult: 1,
    };
  }

  const coreConflictPenalty = Math.min(0.8, inputs.coreViolationCount * 0.4);
  const evolvingConflictPenalty = Math.min(0.3, inputs.evolvingViolationCount * 0.1);
  const conflictPenalty = Math.max(0, 1 - coreConflictPenalty - evolvingConflictPenalty);

  const subtleMult = hasHighSeverity(inputs.subtleConflicts) ? 0.5 : 1.0;

  const structuralContribution = weights.wStructural * clamp01(inputs.domainRelevance);
  const llmContribution = weights.wLlm * clamp01(inputs.domainIntent) * subtleMult;
  const blended = structuralContribution + llmContribution;
  const sa1 = clamp01(blended * conflictPenalty);

  return {
    sa1,
    hardGated: false,
    structuralContribution,
    llmContribution,
    blended,
    conflictPenalty,
    subtleMult,
  };
}

// ── SA-2 ─────────────────────────────────────────────────────────────

export function computeSa2(inputs: Sa2Inputs, weights: PhaseWeights): Sa2Result {
  const tc = normalizeCoverage(inputs.tokenCompliance);
  const ch = normalizeCoverage(inputs.catalogHealth);
  // RFC §B.7.2: computableScore tops out at 0.5 by design — it's half
  // the final SA-2 score. The other half comes from `0.5 × llmComponent`
  // below, so perfect inputs on both layers yield SA-2 = 1.0. See the
  // worked example in composite.test.ts: tc=0.88, ch=0.95 → 0.454.
  const computableScore = 0.3 * tc + 0.2 * ch;

  const rawPenalty =
    inputs.coreDesignAntiPatternCount * 0.3 + inputs.evolvingDesignAntiPatternCount * 0.1;
  const designConflictPenalty = Math.max(0, 1 - Math.min(0.6, rawPenalty));

  const subtleMult = hasHighSeverity(inputs.subtleDesignConflicts) ? 0.5 : 1.0;

  const structuralContribution = weights.wStructural * clamp01(inputs.principleCoverage);
  const llmContribution = weights.wLlm * clamp01(inputs.principleAlignment) * subtleMult;
  const blendedScore = structuralContribution + llmContribution;

  const llmComponent = blendedScore * designConflictPenalty;
  const sa2 = clamp01(computableScore + 0.5 * llmComponent);

  return {
    sa2,
    computableScore,
    structuralContribution,
    llmContribution,
    blendedScore,
    designConflictPenalty,
    subtleMult,
    llmComponent,
  };
}

// ── Public entry point ───────────────────────────────────────────────

export interface SoulAlignmentInput {
  phase: SaPhase;
  /** Required for Phase 3 if calibrated weights differ from the 2c default. */
  calibratedWeights?: PhaseWeights;
  sa1: Sa1Inputs;
  sa2: Sa2Inputs;
}

export function computeSoulAlignment(input: SoulAlignmentInput): SoulAlignmentResult {
  const weights = getPhaseWeights(input.phase, input.calibratedWeights);
  const sa1 = computeSa1(input.sa1, weights);
  const sa2 = computeSa2(input.sa2, weights);
  return {
    phase: input.phase,
    weights,
    shadowMode: input.phase === '2a',
    sa1,
    sa2,
  };
}
