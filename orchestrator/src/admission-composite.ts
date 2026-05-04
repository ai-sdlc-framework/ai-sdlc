/**
 * Admission-subset composite (RFC-0008 §A.6).
 *
 * The admission gate uses a subset of the full PPA composite:
 *
 *   P_admission = SA × D-pi_adjusted × ER × (1 + HC)
 *
 * where:
 *   SA             = soulAlignment               (0–1)
 *   D-pi_adjusted  = rawDP × (1 − defectRiskFactor)
 *   rawDP          = (demand + consensus + conviction + drift) / 4
 *   ER             = min(baseER × autonomyFactor, designSystemReadiness)
 *   baseER         = 1 − complexity / 10
 *   HC             = tanh(weighted sum — see §A.6 Amendment 4)
 *
 * M-phi, E-tau, C-kappa are **deferred to runtime scoring** (§A.6 table):
 * they apply once the issue is admitted and picked up by an executor,
 * not at the admission gate. To keep the returned `PriorityScore`
 * shape consistent with downstream consumers, we fill those dimensions
 * with neutral values: marketForce=1, entropyTax=0, calibration=1
 * (or the configured calibration coefficient if supplied, for display).
 *
 * The `override` bypass is preserved at position 1: when the input has
 * `override: true`, we return `composite = Infinity` without running
 * the admission math — identical to the legacy PPA behaviour.
 */

import type { PriorityConfig, PriorityInput, PriorityScore } from '@ai-sdlc/reference';
import type { AdmissionInput } from './admission-score.js';
import { mapIssueToPriorityInput } from './admission-score.js';
import {
  computeAutonomyFactor,
  computeDefectRiskFactor,
  computeReadinessFromDesignSystemContext,
} from './admission-enrichment.js';
import { computeAdmissionHumanCurve, type AdmissionHumanCurveResult } from './admission-hc.js';

/**
 * Result of the admission composite — returns a `PriorityScore`
 * (backward-compatible with `scoreIssueForAdmission` consumers) plus
 * the admission-specific breakdown for auditability.
 */
export interface AdmissionComposite {
  score: PriorityScore;
  breakdown: {
    soulAlignment: number;
    rawDemandPressure: number;
    defectRiskFactor: number;
    demandPressureAdjusted: number;
    baseExecutionReality: number;
    autonomyFactor: number;
    designSystemReadiness: number;
    executionReality: number;
    humanCurve: AdmissionHumanCurveResult;
  };
}

const DEFAULT_SIGNAL = 0.5;

export interface AdmissionCompositeOptions {
  /**
   * Optional override for the soulAlignment dimension — when present
   * (typically a Phase 2b/2c/3 SA-1 from `scoreSoulAlignment`), it
   * replaces the label-based heuristic. In Phase 2a shadow mode,
   * callers pass undefined and the label-based fallback applies.
   */
  soulAlignmentOverride?: number;
  /**
   * Partial PriorityInput overrides applied AFTER `mapIssueToPriorityInput`.
   * Used by non-GitHub trackers (e.g. Backlog.md adapter) to inject
   * tracker-specific signals — `priority:p*` labels, AC-derived
   * complexity, `qualityFlags` — that the GitHub-shaped mapper
   * cannot extract. Only fields with defined values overwrite.
   */
  priorityInputOverrides?: Partial<PriorityInput>;
}

export function computeAdmissionComposite(
  input: AdmissionInput,
  config?: PriorityConfig,
  options?: AdmissionCompositeOptions,
): AdmissionComposite {
  const timestamp = new Date().toISOString();
  const baseInput = mapIssueToPriorityInput(input);
  const priorityInput = options?.priorityInputOverrides
    ? mergePriorityInputOverrides(baseInput, options.priorityInputOverrides)
    : baseInput;

  // ── Override path: position-1 bypass (§6 / AC #4) ─────────────
  if (priorityInput.override) {
    const score: PriorityScore = {
      composite: Infinity,
      dimensions: {
        soulAlignment: 1,
        demandPressure: 1.5,
        marketForce: 3.0,
        executionReality: 1,
        entropyTax: 0,
        humanCurve: 1,
        calibration: clampCalibration(config?.calibrationCoefficient),
      },
      confidence: 1,
      timestamp,
      override: {
        reason: priorityInput.overrideReason ?? 'No reason provided',
        expiry: priorityInput.overrideExpiry,
      },
    };
    return {
      score,
      breakdown: {
        soulAlignment: 1,
        rawDemandPressure: 1,
        defectRiskFactor: 0,
        demandPressureAdjusted: 1,
        baseExecutionReality: 1,
        autonomyFactor: 1,
        designSystemReadiness: 1,
        executionReality: 1,
        humanCurve: {
          hcExplicit: 0,
          hcConsensus: 0,
          hcDecision: 0,
          hcDesign: 0,
          hcRaw: 0,
          hcComposite: 1,
        },
      },
    };
  }

  // ── SA (soul alignment) — SA-1 override (M5) or label-based fallback ──
  const soulAlignment = clamp01(
    options?.soulAlignmentOverride ?? priorityInput.soulAlignment ?? DEFAULT_SIGNAL,
  );

  // ── D-pi_adjusted ─────────────────────────────────────────────
  const demand = priorityInput.demandSignal ?? DEFAULT_SIGNAL;
  const consensus = priorityInput.teamConsensus ?? DEFAULT_SIGNAL;
  const conviction = priorityInput.builderConviction ?? DEFAULT_SIGNAL;
  const drift = priorityInput.competitiveDrift ?? 0;
  const rawDemandPressure = clamp01((demand + consensus + conviction + drift) / 4);
  const defectRiskFactor = computeDefectRiskFactor(input.codeAreaQuality);
  const demandPressureAdjusted = rawDemandPressure * (1 - defectRiskFactor);

  // ── ER (execution reality) ─────────────────────────────────────
  // baseER = 1 - complexity/10; complexity defaults to neutral midpoint.
  const complexity = priorityInput.complexity ?? 5;
  const baseExecutionReality = clamp01(1 - complexity / 10);
  const autonomyFactor = computeAutonomyFactor(input.autonomyContext);
  const designSystemReadiness = computeReadinessFromDesignSystemContext(input.designSystemContext);
  const executionReality = Math.min(baseExecutionReality * autonomyFactor, designSystemReadiness);

  // ── HC (tanh-compressed with HC_design) ───────────────────────
  const humanCurve = computeAdmissionHumanCurve(input);

  // ── §A.6 admission subset composite ───────────────────────────
  const composite =
    soulAlignment * demandPressureAdjusted * executionReality * (1 + humanCurve.hcComposite);

  const score: PriorityScore = {
    composite,
    dimensions: {
      soulAlignment,
      demandPressure: demandPressureAdjusted,
      // M-phi deferred to runtime — neutral for admission.
      marketForce: 1,
      executionReality,
      // E-tau deferred to runtime — admission does not apply the
      // entropy tax (competitiveDrift feeds rawDP instead).
      entropyTax: 0,
      humanCurve: humanCurve.hcComposite,
      // C-kappa deferred to runtime — expose configured value for
      // display continuity but do not multiply it into `composite`.
      calibration: clampCalibration(config?.calibrationCoefficient),
    },
    confidence: computeAdmissionConfidence(input, priorityInput, options),
    timestamp,
  };

  return {
    score,
    breakdown: {
      soulAlignment,
      rawDemandPressure,
      defectRiskFactor,
      demandPressureAdjusted,
      baseExecutionReality,
      autonomyFactor,
      designSystemReadiness,
      executionReality,
      humanCurve,
    },
  };
}

// ── Admission confidence (AISDLC-172) ──────────────────────────────────

/**
 * `PriorityInput` fields that the admission mapper (`mapIssueToPriorityInput`)
 * actually populates from issue/backlog signals. The full PPA `SCORABLE_FIELDS`
 * list (used by `computeConfidence` in `priority.ts`) includes runtime-only
 * dimensions like `regulatoryUrgency`, `techInflection`, `marketDivergence`,
 * `meetingDecision`, `budgetUtilization`, and `dependencyClearance` — none of
 * which the admission mapper ever sets. Counting against the full 16-field
 * list capped admit confidence at ~9/16 ≈ 0.56 even for fully-shaped issues
 * (RFC-0009 §13 OQ-9 "0.5 ceiling" bug). The mapper-relevant subset is the
 * correct denominator for the mapper-evidence half of the blend.
 */
const ADMISSION_MAPPER_FIELDS: ReadonlyArray<keyof PriorityInput> = [
  'soulAlignment',
  'demandSignal',
  'teamConsensus',
  'builderConviction',
  'complexity',
  'bugSeverity',
  'explicitPriority',
  'competitiveDrift',
  'customerRequestCount',
];

/**
 * RFC-0008 enrichment slots whose presence on `AdmissionInput` indicates
 * an enrichment reader successfully loaded its context. This is the
 * "enrichment-success signal" referenced in the OQ-9 hypothesis:
 *
 *   - `designSystemContext`     ← DSB loader (catalog/token coverage)
 *   - `autonomyContext`         ← AutonomyPolicy (DID-driven) loader
 *   - `codeAreaQuality`         ← code-area metrics loader
 *   - `designAuthoritySignal`   ← maintainers/principals loader
 *   - `soulAlignmentOverride`   ← soul-tracks SA-1 loader (M5 path)
 *
 * Total slots is `5`. Each loaded slot contributes `1/5` to the
 * enrichment-evidence half of the confidence blend.
 */
const ADMISSION_ENRICHMENT_SLOT_COUNT = 5;

function countLoadedEnrichmentSlots(
  input: AdmissionInput,
  options: AdmissionCompositeOptions | undefined,
): number {
  let loaded = 0;
  if (input.designSystemContext) loaded++;
  if (input.autonomyContext) loaded++;
  if (input.codeAreaQuality) loaded++;
  if (input.designAuthoritySignal) loaded++;
  if (options?.soulAlignmentOverride !== undefined) loaded++;
  return loaded;
}

/**
 * Compute admission confidence in [0, 1] as a 50/50 blend of two
 * independent evidence channels:
 *
 *   1. **Mapper coverage** — fraction of `ADMISSION_MAPPER_FIELDS`
 *      explicitly populated on the derived `PriorityInput`. Captures
 *      "how much issue/backlog signal did `mapIssueToPriorityInput`
 *      extract".
 *
 *   2. **Enrichment loaded** — fraction of RFC-0008 enrichment slots
 *      present on the input (or supplied via `options`). Captures "how
 *      much external context did the enrichment readers contribute".
 *
 * Bug fixed (AISDLC-172 / RFC-0009 §13 OQ-9): previously
 * `computeConfidence(priorityInput)` from `priority.ts` was used, which
 * counts against the full 16-field `SCORABLE_FIELDS` list and ignores
 * enrichment success entirely. The result was a hard ~0.5 ceiling on
 * admit confidence even when DID + DSB + maintainers + soul-tracks all
 * loaded — those four positive observations contributed exactly zero
 * to the formula's denominator and zero to its numerator.
 */
export function computeAdmissionConfidence(
  input: AdmissionInput,
  priorityInput: PriorityInput,
  options?: AdmissionCompositeOptions,
): number {
  let providedMapper = 0;
  for (const field of ADMISSION_MAPPER_FIELDS) {
    if (priorityInput[field] !== undefined) providedMapper++;
  }
  const mapperFraction = providedMapper / ADMISSION_MAPPER_FIELDS.length;

  const loadedEnrichment = countLoadedEnrichmentSlots(input, options);
  const enrichmentFraction = loadedEnrichment / ADMISSION_ENRICHMENT_SLOT_COUNT;

  return 0.5 * mapperFraction + 0.5 * enrichmentFraction;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampCalibration(value: number | undefined): number {
  if (value === undefined) return 1.0;
  return Math.min(1.3, Math.max(0.7, value));
}

/**
 * Apply non-GitHub tracker overrides on top of the GitHub-shaped
 * `mapIssueToPriorityInput` output. A field's override wins iff it is
 * not `undefined`; this preserves the GitHub mapper's defaults for
 * any field the override does not specify.
 */
function mergePriorityInputOverrides(
  base: PriorityInput,
  overrides: Partial<PriorityInput>,
): PriorityInput {
  const merged: PriorityInput = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}
