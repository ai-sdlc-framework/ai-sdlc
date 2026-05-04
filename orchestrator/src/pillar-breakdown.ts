/**
 * Pillar breakdown & tension detection (RFC-0008 §A.6 + Amendment 6).
 *
 * The admission composite produces a single scalar, but downstream
 * reviewers (product, design, engineering) want to see *which pillar*
 * the score came from — so they can act on a mismatch between a
 * strong product signal and a weak design or engineering one.
 *
 * This module takes the `AdmissionComposite.breakdown` emitted by
 * `computeAdmissionComposite` and produces:
 *   - three `PillarContribution`s (product/design/engineering)
 *   - `SharedDimensions` (SA-3 placeholder + HC channel map)
 *   - tension flags detected from pillar mismatch
 */

import type { AdmissionComposite } from './admission-composite.js';

export type PillarName = 'product' | 'design' | 'engineering';

export type TensionFlagType =
  | 'PRODUCT_HIGH_DESIGN_LOW'
  | 'PRODUCT_HIGH_ENGINEERING_LOW'
  | 'DESIGN_HIGH_PRODUCT_LOW'
  | 'ENGINEERING_HIGH_PRODUCT_LOW'
  | 'ALL_MEDIUM';

export interface PillarContribution {
  pillar: PillarName;
  /** PPA/RFC dimension labels attributed to this pillar at admission time. */
  governedDimensions: string[];
  /** Aggregate pillar signal in [0, 1]. */
  signal: number;
  /** Stable human-readable interpretation (snapshot-tested). */
  interpretation: string;
}

export interface HcChannelBreakdown {
  explicit: number;
  consensus: number;
  decision: number;
  design: number;
}

export interface SharedDimensions {
  /**
   * SA-3 (shared intent) — unavailable at admission in Phase 1; M5
   * populates this once the SA-1/SA-2/SA-3 decomposition lands.
   */
  saAlpha3?: number;
  /**
   * Per-channel HC breakdown with the tanh composite for reference.
   *
   * `designAuthorityConfigured` (AISDLC-171) — diagnostic flag set when
   * the resolved DSB declares any `stewardship.designAuthority.principals`
   * entries, regardless of whether one of them participated in the issue.
   * Lets operators distinguish three pillarBreakdown states for the design
   * channel:
   *   - `design = 0` and `configured === undefined` → no DSB resolved
   *     (preDesignSystem). HC_design intentionally inert.
   *   - `design = 0` and `configured === true`     → DSB declares design
   *     authority but no principal participated as author/commenter.
   *     HC_design intentionally 0 per RFC-0008 §14.2 (only principals
   *     emit full-weight HC_design signals; non-principal opinions route
   *     through HC_consensus, not HC_design).
   *   - `design ≠ 0` and `configured === true`     → a principal
   *     participated; signal weight reflects label-derived signalType.
   *
   * The `false` case (DSB exists but `principals` is empty) is also
   * surfaced for completeness — a DSB without designAuthority principals
   * cannot ever fire HC_design and operators should know.
   */
  hcComposite: HcChannelBreakdown & {
    value: number;
    designAuthorityConfigured?: boolean;
  };
}

export interface TensionFlag {
  type: TensionFlagType;
  /** Stable suggestion string per tension type (snapshot-tested). */
  suggestedAction: string;
}

export interface PillarBreakdown {
  product: PillarContribution;
  design: PillarContribution;
  engineering: PillarContribution;
  shared: SharedDimensions;
  tensions: TensionFlag[];
}

// ── Thresholds ─────────────────────────────────────────────────────────

const HIGH_THRESHOLD = 0.7;
const LOW_THRESHOLD = 0.3;
const MEDIUM_LOW = 0.3;
const MEDIUM_HIGH = 0.5;

// ── Suggested actions (stable) ─────────────────────────────────────────

const SUGGESTED_ACTIONS: Readonly<Record<TensionFlagType, string>> = Object.freeze({
  PRODUCT_HIGH_DESIGN_LOW:
    'Product intent is strong but design-system readiness is weak; consider catalog-first work or route through design authority before building.',
  PRODUCT_HIGH_ENGINEERING_LOW:
    'Product intent is strong but engineering signal is weak; address the defect-density, autonomy gap, or complexity before building.',
  DESIGN_HIGH_PRODUCT_LOW:
    'Design signal is strong but product demand is low; confirm product alignment before scheduling.',
  ENGINEERING_HIGH_PRODUCT_LOW:
    'Engineering area health is strong but product demand is weak; surface more demand evidence before scheduling.',
  ALL_MEDIUM:
    'All pillars are in the neutral band; the score is likely noise — gather more evidence or defer.',
});

// ── Public API ─────────────────────────────────────────────────────────

export function computePillarBreakdown(composite: AdmissionComposite): PillarBreakdown {
  const b = composite.breakdown;

  // Product: SA-1 (soulAlignment proxy), D-pi, HC_explicit
  const productSignal = mean([
    b.soulAlignment,
    b.demandPressureAdjusted,
    normalizeSigned(b.humanCurve.hcExplicit),
  ]);
  const product: PillarContribution = {
    pillar: 'product',
    governedDimensions: ['SA-1', 'D-pi', 'HC_explicit'],
    signal: productSignal,
    interpretation: interpret(
      'Product',
      productSignal,
      'mission alignment, demand, and explicit priority',
    ),
  };

  // Design: ER-4 (designSystemReadiness) + HC_design; SA-2 deferred to M5.
  const designSignal = mean([b.designSystemReadiness, normalizeSigned(b.humanCurve.hcDesign)]);
  const design: PillarContribution = {
    pillar: 'design',
    governedDimensions: ['ER-4', 'HC_design'],
    signal: designSignal,
    interpretation: interpret(
      'Design',
      designSignal,
      'design-system readiness and design-authority signal',
    ),
  };

  // Engineering: ER-1 (baseER), ER-2 (autonomyFactor), defectRiskFactor inverse.
  // defectRiskFactor is clamped upstream to [0, 0.5]; the clamp01 here is
  // a defence-in-depth guard so a regression in the upstream clamp can't
  // feed a negative value into `mean()` and corrupt the engineering signal.
  const engineeringSignal = mean([
    b.baseExecutionReality,
    b.autonomyFactor,
    clamp01(1 - 2 * b.defectRiskFactor),
  ]);
  const engineering: PillarContribution = {
    pillar: 'engineering',
    governedDimensions: ['ER-1', 'ER-2', 'ER-3'],
    signal: engineeringSignal,
    interpretation: interpret(
      'Engineering',
      engineeringSignal,
      'complexity feasibility, autonomy gap, and code-area defect risk',
    ),
  };

  const shared: SharedDimensions = {
    hcComposite: {
      explicit: b.humanCurve.hcExplicit,
      consensus: b.humanCurve.hcConsensus,
      decision: b.humanCurve.hcDecision,
      design: b.humanCurve.hcDesign,
      value: b.humanCurve.hcComposite,
      // AISDLC-171: only include the flag when the underlying signal
      // populated it (i.e., a DSB was resolved). Leaving it `undefined`
      // when no DSB was supplied keeps the preDesignSystem state
      // distinct from the "configured but inactive" state at the API
      // surface — operators inspecting `pillarBreakdown.shared` can
      // tell the three states apart without reading the DSB themselves.
      ...(b.humanCurve.designAuthorityConfigured !== undefined
        ? { designAuthorityConfigured: b.humanCurve.designAuthorityConfigured }
        : {}),
    },
  };

  const tensions = detectTensions({ product, design, engineering, shared, tensions: [] });

  return { product, design, engineering, shared, tensions };
}

export function detectTensions(breakdown: PillarBreakdown): TensionFlag[] {
  const flags: TensionFlag[] = [];
  const p = breakdown.product.signal;
  const d = breakdown.design.signal;
  const e = breakdown.engineering.signal;

  if (p > HIGH_THRESHOLD && d < LOW_THRESHOLD) {
    flags.push({
      type: 'PRODUCT_HIGH_DESIGN_LOW',
      suggestedAction: SUGGESTED_ACTIONS.PRODUCT_HIGH_DESIGN_LOW,
    });
  }
  if (p > HIGH_THRESHOLD && e < LOW_THRESHOLD) {
    flags.push({
      type: 'PRODUCT_HIGH_ENGINEERING_LOW',
      suggestedAction: SUGGESTED_ACTIONS.PRODUCT_HIGH_ENGINEERING_LOW,
    });
  }
  if (d > HIGH_THRESHOLD && p < LOW_THRESHOLD) {
    flags.push({
      type: 'DESIGN_HIGH_PRODUCT_LOW',
      suggestedAction: SUGGESTED_ACTIONS.DESIGN_HIGH_PRODUCT_LOW,
    });
  }
  if (e > HIGH_THRESHOLD && p < LOW_THRESHOLD) {
    flags.push({
      type: 'ENGINEERING_HIGH_PRODUCT_LOW',
      suggestedAction: SUGGESTED_ACTIONS.ENGINEERING_HIGH_PRODUCT_LOW,
    });
  }
  // ALL_MEDIUM: all three pillars strictly inside [MEDIUM_LOW, MEDIUM_HIGH]
  if (inMediumBand(p) && inMediumBand(d) && inMediumBand(e)) {
    flags.push({
      type: 'ALL_MEDIUM',
      suggestedAction: SUGGESTED_ACTIONS.ALL_MEDIUM,
    });
  }
  return flags;
}

/**
 * Aggregate pillar signal in [0, 1]. Exposed so consumers can compute
 * pillar scores without needing the full `AdmissionComposite`.
 */
export function pillarSignalScore(signals: readonly number[]): number {
  return mean(signals);
}

// ── Helpers ────────────────────────────────────────────────────────────

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return clamp01(sum / values.length);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Map a signed [-1, 1] HC channel onto the pillar's unsigned [0, 1] scale. */
function normalizeSigned(value: number): number {
  return clamp01((value + 1) / 2);
}

function interpret(pillar: string, signal: number, what: string): string {
  const band = signalBand(signal);
  return `${band} ${pillar} signal (${signal.toFixed(2)}) from ${what}`;
}

function signalBand(signal: number): string {
  if (signal >= HIGH_THRESHOLD) return 'strong';
  if (signal >= MEDIUM_HIGH) return 'moderate';
  if (signal >= MEDIUM_LOW) return 'neutral';
  return 'weak';
}

function inMediumBand(value: number): boolean {
  return value >= MEDIUM_LOW && value <= MEDIUM_HIGH;
}
