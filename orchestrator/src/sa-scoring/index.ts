/**
 * SA scoring orchestration (RFC-0008 Addendum B §B.7.3).
 *
 * `scoreSoulAlignment(input, deps)` runs the three-layer SA scorer end
 * to end with phase-aware short-circuits:
 *
 *   - Layer 1 hard gate → skips Layer 2/3, SA-1 forced to 0
 *   - Phase 2a shadow  → all layers computed + persisted, but
 *                         shadowMode=true signals caller to use
 *                         label-based soulAlignment in ranking
 *   - Phase 2b/2c/3    → sa1 replaces label-based soulAlignment
 *
 * Persists one `did_scoring_events` row per dimension so operators can
 * query per-dimension precision by phase.
 */

import type { DesignIntentDocument, DesignSystemBinding } from '@ai-sdlc/reference';
import type { StateStore } from '../state/store.js';
import type { SaDimension, SaPhase as StateSaPhase } from '../state/types.js';
import { compileDid, type CompiledDid } from './did-compiler.js';
import type { DepparseClient } from './depparse-client.js';
import type { LLMClient } from './layer3-llm.js';
import { runLayer1, type DeterministicScoringResult } from './layer1-deterministic.js';
import {
  computeDomainRelevance,
  computePrincipleCoverage,
  type DomainRelevanceResult,
  type PrincipleCoverageVector,
} from './layer2-structural.js';
import { runLayer3, type LLMScoringResult } from './layer3-llm.js';
import {
  computeSoulAlignment,
  type PhaseWeights,
  type SaPhase,
  type SoulAlignmentResult,
} from './composite.js';

// ── Public API types ─────────────────────────────────────────────────

export interface ScoreSoulAlignmentInput {
  issueText: string;
  did: DesignIntentDocument;
  dsb?: DesignSystemBinding;
  phase: SaPhase;
  calibratedWeights?: PhaseWeights;
  /** Observed metrics keyed by signal metric name (for Layer 1). */
  observedMetrics?: Record<string, number>;
  /** Issue number for audit trail — used when persisting did_scoring_events. */
  issueNumber?: number;
}

export interface ScoreSoulAlignmentDeps {
  depparse: DepparseClient;
  llm: LLMClient;
  stateStore?: StateStore;
  /** Pre-compiled DID (skip recompilation). */
  compiledDid?: CompiledDid;
}

export interface SoulAlignmentScoringResult {
  /** Final composite SA-1/SA-2 (respecting shadow mode). */
  sa1: number;
  sa2: number;
  /** Full composite result including per-layer contributions. */
  composite: SoulAlignmentResult;
  /** Raw Layer 1 output (useful for preVerifiedSummary). */
  layer1: DeterministicScoringResult;
  /** Raw Layer 2 outputs. Always computed (even in shadow mode). */
  layer2: {
    domainRelevance: DomainRelevanceResult;
    principleCoverage: PrincipleCoverageVector;
  };
  /** Raw Layer 3 output. Absent when Layer 1 hard-gated (skipped). */
  layer3?: LLMScoringResult;
  /** True when Phase 2a — caller must use label-based soulAlignment. */
  shadowMode: boolean;
  /** Audit — phase + weights used. */
  phase: SaPhase;
  weights: PhaseWeights;
}

// ── Orchestration ───────────────────────────────────────────────────

export async function scoreSoulAlignment(
  input: ScoreSoulAlignmentInput,
  deps: ScoreSoulAlignmentDeps,
): Promise<SoulAlignmentScoringResult> {
  const compiled = deps.compiledDid ?? compileDid(input.did);

  // ── Layer 1 (deterministic) ────────────────────────────────────
  const layer1 = await runLayer1({
    issueText: input.issueText,
    compiled,
    depparse: deps.depparse,
    observedMetrics: input.observedMetrics,
  });

  // ── Layer 2 (BM25 structural) ──────────────────────────────────
  // Always compute, even in shadow mode, so precision tracking works.
  const domainRelevance = computeDomainRelevance(input.issueText, compiled.bm25Corpus);
  const principleCoverage = computePrincipleCoverage(input.issueText, compiled.principleCorpora);

  // ── Layer 3 (LLM) ──────────────────────────────────────────────
  // Skip Layer 3 if hard-gated — SA-1 = 0 short-circuits regardless
  // of what the LLM might say. Matches §B.7.1 STOP condition.
  let layer3: LLMScoringResult | undefined;
  if (!layer1.hardGated) {
    layer3 = await runLayer3({
      issueText: input.issueText,
      did: input.did,
      dsb: input.dsb,
      preVerifiedSummary: layer1.preVerifiedSummary,
      llm: deps.llm,
    });
  }

  // ── DSB-derived computable inputs for SA-2 ────────────────────
  const tokenCompliance = input.dsb?.status?.tokenCompliance?.currentCoverage ?? 0;
  const catalogHealth = input.dsb?.status?.catalogHealth?.coveragePercent ?? 0;

  // Count design anti-pattern hits for SA-2 conflict penalty.
  const coreDesignAntiPatternCount = layer1.designAntiPatternHits.hits.filter(
    (h) => h.identityClass === 'core',
  ).length;
  const evolvingDesignAntiPatternCount = layer1.designAntiPatternHits.hits.filter(
    (h) => h.identityClass === 'evolving',
  ).length;

  // ── Composite ─────────────────────────────────────────────────
  const composite = computeSoulAlignment({
    phase: input.phase,
    calibratedWeights: input.calibratedWeights,
    sa1: {
      hardGated: layer1.hardGated,
      coreViolationCount: layer1.coreViolationCount,
      evolvingViolationCount: layer1.evolvingViolationCount,
      domainRelevance: domainRelevance.score,
      domainIntent: layer3?.domainIntent ?? 0,
      subtleConflicts: layer3?.subtleConflicts ?? [],
    },
    sa2: {
      tokenCompliance,
      catalogHealth,
      principleCoverage: principleCoverage.overallCoverage,
      principleAlignment: layer3?.principleAlignment ?? 0,
      coreDesignAntiPatternCount,
      evolvingDesignAntiPatternCount,
      subtleDesignConflicts: layer3?.subtleDesignConflicts ?? [],
    },
  });

  // ── Persist to did_scoring_events (one row per dimension) ─────
  if (deps.stateStore && input.issueNumber !== undefined) {
    persistScoringEvent(deps.stateStore, {
      didName: input.did.metadata.name,
      issueNumber: input.issueNumber,
      dimension: 'SA-1',
      phase: input.phase as StateSaPhase,
      weights: composite.weights,
      layer1,
      layer2: domainRelevance,
      layer3Sa1: layer3
        ? {
            domainIntent: layer3.domainIntent,
            domainIntentConfidence: layer3.domainIntentConfidence,
            subtleConflicts: layer3.subtleConflicts,
          }
        : undefined,
      compositeScore: composite.sa1.sa1,
    });
    persistScoringEvent(deps.stateStore, {
      didName: input.did.metadata.name,
      issueNumber: input.issueNumber,
      dimension: 'SA-2',
      phase: input.phase as StateSaPhase,
      weights: composite.weights,
      layer1,
      layer2: principleCoverage,
      layer3Sa2: layer3
        ? {
            principleAlignment: layer3.principleAlignment,
            principleAlignmentConfidence: layer3.principleAlignmentConfidence,
            subtleDesignConflicts: layer3.subtleDesignConflicts,
          }
        : undefined,
      compositeScore: composite.sa2.sa2,
    });
  }

  return {
    sa1: composite.sa1.sa1,
    sa2: composite.sa2.sa2,
    composite,
    layer1,
    layer2: { domainRelevance, principleCoverage },
    layer3,
    shadowMode: composite.shadowMode,
    phase: input.phase,
    weights: composite.weights,
  };
}

// ── Persistence helpers ──────────────────────────────────────────────

interface PersistEventInput {
  didName: string;
  issueNumber: number;
  dimension: SaDimension;
  phase: StateSaPhase;
  weights: PhaseWeights;
  layer1: DeterministicScoringResult;
  layer2: DomainRelevanceResult | PrincipleCoverageVector;
  layer3Sa1?: {
    domainIntent: number;
    domainIntentConfidence: number;
    subtleConflicts: unknown[];
  };
  layer3Sa2?: {
    principleAlignment: number;
    principleAlignmentConfidence: number;
    subtleDesignConflicts: unknown[];
  };
  compositeScore: number;
}

function persistScoringEvent(store: StateStore, input: PersistEventInput): void {
  const layer1Summary = {
    hardGated: input.layer1.hardGated,
    coreViolationCount: input.layer1.coreViolationCount,
    evolvingViolationCount: input.layer1.evolvingViolationCount,
    scopeOutOfScopeHits: input.layer1.scopeGate.outOfScopeHits.length,
    constraintViolations: input.layer1.constraintViolations.violations.length,
    antiPatternHits:
      input.layer1.antiPatternHits.hits.length + input.layer1.designAntiPatternHits.hits.length,
  };

  const layer3Payload = input.layer3Sa1 ?? input.layer3Sa2;

  store.recordDidScoringEvent({
    didName: input.didName,
    issueNumber: input.issueNumber,
    saDimension: input.dimension,
    phase: input.phase,
    layer1ResultJson: JSON.stringify(layer1Summary),
    layer2ResultJson: JSON.stringify(input.layer2),
    layer3ResultJson: layer3Payload ? JSON.stringify(layer3Payload) : undefined,
    compositeScore: input.compositeScore,
    phaseWeightsJson: JSON.stringify(input.weights),
  });
}

// ── Admission-composite integration helpers ──────────────────────────

/**
 * Resolve the soulAlignment value to feed the admission composite
 * based on phase + SA result. In shadow mode (2a), returns undefined
 * so the caller falls back to the label-based heuristic.
 */
export function resolveSoulAlignmentOverride(
  result: SoulAlignmentScoringResult,
): number | undefined {
  if (result.shadowMode) return undefined;
  return result.sa1;
}
