/**
 * Bridge between stateless admission scoring and the stateful orchestrator
 * (RFC-0008 Addendum A §A.2 – §A.5).
 *
 * `enrichAdmissionInput()` reads from the orchestrator's state store and
 * resolved resources to populate the RFC-0008 context fields on
 * `AdmissionInput`, then `computeDesignSystemReadiness()` produces the
 * Eρ₄ scalar that feeds the admission composite in §A.6.
 *
 * Scope for AISDLC-43: implement C2 (Eρ₄) only. C3/C4/C5 are populated
 * by later tasks (AISDLC-44/45/46).
 */

import type { AutonomyPolicy, DesignIntentDocument, DesignSystemBinding } from '@ai-sdlc/reference';
import type { StateStore } from './state/store.js';
import type {
  AdmissionInput,
  AutonomyContext,
  CodeAreaQuality,
  DesignAuthoritySignal,
  DesignQualityMetrics,
  DesignSystemContext,
} from './admission-score.js';
import { checkHasFrontendComponents } from './code-area-classifier.js';
import { checkDesignAuthority } from './design-authority.js';

/**
 * Minimum data points required before `code_area_metrics` is trusted
 * enough to drive defect-risk penalties (RFC-0008 §7.4 Open Question 4).
 */
export const CODE_AREA_METRICS_MIN_DATA_POINTS = 10;

/** Default window (ms) for `getCodeAreaMetrics` lookups — 90 days. */
const DEFAULT_METRICS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export type LifecyclePhase = 'preDesignSystem' | 'catalogBootstrap' | 'postDesignSystem';

export interface EnrichmentContext {
  /** State store for reading visual baselines and code-area metrics. */
  stateStore?: StateStore;
  /** Resolved DesignSystemBinding referenced by the DID (absent ⇒ preDesignSystem). */
  designSystemBinding?: DesignSystemBinding;
  /** Resolved DesignIntentDocument. Unused in C2 but threaded through for future connections. */
  designIntentDocument?: DesignIntentDocument;
  /** ISO timestamp when the DSB was adopted — used for age-based lifecycle detection. */
  dsbAdoptedAt?: string;
  /** Catalog gaps supplied by a catalog-provider adapter (AISDLC-43 accepts these pre-computed). */
  catalogGaps?: string[];
  /** Code area for the issue (e.g. "orchestrator/src/priority"), used by C3. */
  codeArea?: string;
  /** Resolved AutonomyPolicy — used by C4. */
  autonomyPolicy?: AutonomyPolicy;
  /**
   * Agent expected to handle the issue. Used to pick a specific entry
   * from `autonomyPolicy.status.agents`. When absent, the most
   * permissive currently-earned level across all agents is used.
   */
  agentName?: string;
  /**
   * Task complexity in [0, 10] for mapping to a required autonomy level.
   * When omitted, C4 falls back to the most permissive level for the
   * resolved agent (requiredLevel = currentEarnedLevel → gap = 0).
   */
  complexity?: number;
  /**
   * Compliance score for the issue's area in [0, 1]. When present,
   * `designAuthorityWeight` is modulated by `(1.2 - areaComplianceScore)`.
   * When absent, the base weight applies unmodulated.
   */
  areaComplianceScore?: number;
  /** Clock injection for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Populate `designSystemContext` on the admission input using the
 * resolved DSB and state store. Returns the input unchanged when no DSB
 * is available (preDesignSystem phase — caller falls through to the
 * stateless path).
 */
export function enrichAdmissionInput(
  input: AdmissionInput,
  ctx: EnrichmentContext,
): AdmissionInput {
  const binding = ctx.designSystemBinding;
  const codeAreaQuality = ctx.codeArea
    ? buildCodeAreaQuality(ctx.codeArea, ctx.stateStore, ctx.now)
    : undefined;
  const autonomyContext = buildAutonomyContext(ctx);
  const designAuthoritySignal = buildDesignAuthoritySignal(input, ctx);

  if (!binding) {
    const next: AdmissionInput = { ...input };
    if (codeAreaQuality) next.codeAreaQuality = codeAreaQuality;
    if (autonomyContext) next.autonomyContext = autonomyContext;
    if (designAuthoritySignal) next.designAuthoritySignal = designAuthoritySignal;
    return next;
  }

  const catalogCoverageRaw = binding.status?.catalogHealth?.coveragePercent;
  const tokenComplianceRaw = binding.status?.tokenCompliance?.currentCoverage;
  const catalogCoverage = normalizeCoverage(catalogCoverageRaw);
  const tokenCompliance = normalizeCoverage(tokenComplianceRaw);
  const baselineCoverage = ctx.stateStore
    ? computeBaselineCoverage(ctx.stateStore, binding.metadata.name)
    : 0;
  const ageDays = computeDsbAgeDays(ctx.dsbAdoptedAt, ctx.now);
  const phase = detectLifecyclePhase(binding, catalogCoverage, ageDays);

  const context: DesignSystemContext = {
    catalogCoverage,
    tokenCompliance,
    inBootstrapPhase: phase === 'catalogBootstrap',
    baselineCoverage,
    catalogGaps: ctx.catalogGaps ?? [],
  };

  return {
    ...input,
    designSystemContext: context,
    ...(codeAreaQuality ? { codeAreaQuality } : {}),
    ...(autonomyContext ? { autonomyContext } : {}),
    ...(designAuthoritySignal ? { designAuthoritySignal } : {}),
  };
}

/**
 * Read code-area metrics within the 90-day window and project them into
 * the `CodeAreaQuality` shape. Returns undefined when the metric row is
 * missing or has fewer than `CODE_AREA_METRICS_MIN_DATA_POINTS` samples —
 * downstream defect-risk consumers treat "absent" as 0 penalty.
 */
function buildCodeAreaQuality(
  codeArea: string,
  store: StateStore | undefined,
  now: (() => number) | undefined,
): CodeAreaQuality | undefined {
  if (!store) {
    // No state → fall back to heuristic classification only.
    return { hasFrontendComponents: checkHasFrontendComponents(codeArea) };
  }

  const windowStart = new Date(
    (now ?? (() => Date.now()))() - DEFAULT_METRICS_WINDOW_MS,
  ).toISOString();
  const metrics = store.getCodeAreaMetrics(codeArea, { since: windowStart });

  if (!metrics || (metrics.dataPointCount ?? 0) < CODE_AREA_METRICS_MIN_DATA_POINTS) {
    return undefined;
  }

  const designQuality = parseDesignQuality(metrics.designMetricsJson);

  return {
    defectDensity: metrics.defectDensity,
    churnRate: metrics.churnRate,
    prRejectionRate: metrics.prRejectionRate,
    hasFrontendComponents: metrics.hasFrontendComponents ?? false,
    ...(designQuality ? { designQuality } : {}),
  };
}

function parseDesignQuality(json: string | undefined): DesignQualityMetrics | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as Partial<DesignQualityMetrics>;
    if (
      parsed.designCIPassRate === undefined &&
      parsed.designReviewRejectionRate === undefined &&
      parsed.usabilitySimPassRate === undefined
    ) {
      return undefined;
    }
    return parsed as DesignQualityMetrics;
  } catch {
    return undefined;
  }
}

/**
 * Compute the C3 defect-risk factor per §A.5. Returns 0 when
 * `codeAreaQuality` is absent (insufficient data → no penalty).
 *
 *   !hasFrontendComponents  → 0.5×dd + 0.3×churn + 0.2×prRej
 *   hasFrontendComponents
 *     no designQuality      → same as pure code (no blend target)
 *     with designQuality    → 0.7 × code + 0.3 × design
 *                              where design = 0.4×(1-ciPass)
 *                                           + 0.4×reviewRej
 *                                           + 0.2×(1-usabPass)
 *
 * Final value is clamped to [0, 0.5].
 */
export function computeDefectRiskFactor(quality: CodeAreaQuality | undefined): number {
  if (!quality) return 0;

  const code =
    0.5 * (quality.defectDensity ?? 0) +
    0.3 * (quality.churnRate ?? 0) +
    0.2 * (quality.prRejectionRate ?? 0);

  if (!quality.hasFrontendComponents || !quality.designQuality) {
    return clamp(code, 0, 0.5);
  }

  const dq = quality.designQuality;
  const ciPass = dq.designCIPassRate ?? 1;
  const reviewRej = dq.designReviewRejectionRate ?? 0;
  const usabPass = dq.usabilitySimPassRate ?? 1;
  const design = 0.4 * (1 - ciPass) + 0.4 * reviewRej + 0.2 * (1 - usabPass);

  const blended = 0.7 * code + 0.3 * design;
  return clamp(blended, 0, 0.5);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ── C4 Autonomy Factor ─────────────────────────────────────────────────

/**
 * Map task complexity to the required autonomy level per §A.4:
 *   complexity ≤ 3  → level 1
 *   complexity ≤ 6  → level 2
 *   else            → level 3
 */
export function complexityToAutonomyLevel(complexity: number): number {
  if (complexity <= 3) return 1;
  if (complexity <= 6) return 2;
  return 3;
}

/**
 * Compute the C4 autonomy factor per §A.5:
 *   gap = requiredLevel - currentEarnedLevel
 *   gap > 0  → max(0.1, 1.0 - gap × 0.4)
 *   gap ≤ 0  → 1.0
 */
export function computeAutonomyFactor(ctx: AutonomyContext | undefined): number {
  if (!ctx) return 1.0;
  const gap = ctx.requiredLevel - ctx.currentEarnedLevel;
  if (gap <= 0) return 1.0;
  return Math.max(0.1, 1.0 - gap * 0.4);
}

function buildAutonomyContext(ctx: EnrichmentContext): AutonomyContext | undefined {
  if (!ctx.autonomyPolicy) return undefined;
  const agents = ctx.autonomyPolicy.status?.agents ?? [];
  if (agents.length === 0) return undefined;

  const selected = ctx.agentName
    ? agents.find((a) => a.name === ctx.agentName)
    : pickMostPermissiveAgent(agents);

  if (!selected) return undefined;

  const currentEarnedLevel = selected.currentLevel;
  const requiredLevel =
    ctx.complexity !== undefined ? complexityToAutonomyLevel(ctx.complexity) : currentEarnedLevel;

  return { currentEarnedLevel, requiredLevel };
}

function pickMostPermissiveAgent<T extends { currentLevel: number }>(agents: T[]): T {
  return agents.reduce((best, a) => (a.currentLevel > best.currentLevel ? a : best), agents[0]);
}

// ── C5 Design Authority Signal + HC_design ─────────────────────────────

/** Base weights per signal type (§A.5) before compliance modulation. */
const DESIGN_AUTHORITY_BASE_WEIGHT: Readonly<
  Record<NonNullable<DesignAuthoritySignal['signalType']>, number>
> = Object.freeze({
  'advances-design-coherence': 0.6,
  'fills-catalog-gap': 0.6,
  'fragments-component-catalog': -0.4,
  'misaligned-with-brand': -0.4,
  unspecified: 0.3,
});

/**
 * Compute the C5 design-authority weight per §A.5.
 *
 *   non-authority           → 0.0
 *   authority + positive    → +0.6 × modulation
 *   authority + negative    → -0.4 × modulation
 *   authority + no type     → +0.3 × modulation
 *
 * where `modulation = 1.2 - areaComplianceScore` when the score is
 * supplied, else `1.0` (unmodulated base weight).
 */
export function computeDesignAuthorityWeight(signal: DesignAuthoritySignal | undefined): number {
  if (!signal || !signal.isDesignAuthority) return 0;
  const signalType = signal.signalType ?? 'unspecified';
  const base = DESIGN_AUTHORITY_BASE_WEIGHT[signalType];
  const modulation =
    signal.areaComplianceScore !== undefined ? 1.2 - signal.areaComplianceScore : 1;
  return base * modulation;
}

function buildDesignAuthoritySignal(
  input: AdmissionInput,
  ctx: EnrichmentContext,
): DesignAuthoritySignal | undefined {
  if (!ctx.designSystemBinding) return undefined;
  const { isDesignAuthority, signalType } = checkDesignAuthority(
    {
      authorLogin: input.authorLogin,
      commenterLogins: input.commenterLogins,
      labels: input.labels,
    },
    ctx.designSystemBinding,
  );
  if (!isDesignAuthority) return { isDesignAuthority: false };
  return {
    isDesignAuthority: true,
    signalType,
    ...(ctx.areaComplianceScore !== undefined
      ? { areaComplianceScore: ctx.areaComplianceScore }
      : {}),
  };
}

/**
 * Compute the C2 Eρ₄ design-system readiness scalar in [0, 1] per §A.5.
 *
 *   preDesignSystem:   1.0 (no DSB → no penalty)
 *   catalogBootstrap:  max(0.3, 0.4×cat + 0.3×tok + 0.3×baseline)
 *   postDesignSystem:  0.4×cat + 0.3×tok + 0.3×baseline
 */
export function computeDesignSystemReadiness(ctx: EnrichmentContext): number {
  const binding = ctx.designSystemBinding;
  if (!binding) return 1.0;

  const catalogCoverage = normalizeCoverage(binding.status?.catalogHealth?.coveragePercent);
  const tokenCompliance = normalizeCoverage(binding.status?.tokenCompliance?.currentCoverage);
  const baselineCoverage = ctx.stateStore
    ? computeBaselineCoverage(ctx.stateStore, binding.metadata.name)
    : 0;
  const ageDays = computeDsbAgeDays(ctx.dsbAdoptedAt, ctx.now);
  const phase = detectLifecyclePhase(binding, catalogCoverage, ageDays);

  const computed = 0.4 * catalogCoverage + 0.3 * tokenCompliance + 0.3 * baselineCoverage;

  if (phase === 'catalogBootstrap') return Math.max(0.3, computed);
  return computed;
}

/**
 * Compute the C2 Eρ₄ scalar directly from the DesignSystemContext
 * already populated on an `AdmissionInput` (no DSB/state lookups).
 *
 *   undefined (preDesignSystem) → 1.0
 *   inBootstrapPhase            → max(0.3, computed)
 *   else                        → computed
 *
 * Used by the admission composite (§A.6) to avoid re-reading the state
 * store on every score call.
 */
export function computeReadinessFromDesignSystemContext(
  context: DesignSystemContext | undefined,
): number {
  if (!context) return 1.0;
  const catalogCoverage = normalizeCoverage(context.catalogCoverage);
  const tokenCompliance = normalizeCoverage(context.tokenCompliance);
  const baselineCoverage = normalizeCoverage(context.baselineCoverage);
  const computed = 0.4 * catalogCoverage + 0.3 * tokenCompliance + 0.3 * baselineCoverage;
  if (context.inBootstrapPhase) return Math.max(0.3, computed);
  return computed;
}

export function detectLifecyclePhase(
  binding: DesignSystemBinding | undefined,
  normalizedCatalogCoverage: number,
  ageDays: number,
): LifecyclePhase {
  if (!binding) return 'preDesignSystem';
  if (normalizedCatalogCoverage < 0.2 && ageDays < 90) return 'catalogBootstrap';
  return 'postDesignSystem';
}

/**
 * Days since the DSB was adopted. Returns 0 when no adoption timestamp
 * is supplied — the conservative default (treats DSB as brand-new and
 * favours the bootstrap floor).
 */
export function computeDsbAgeDays(adoptedAt: string | undefined, now?: () => number): number {
  if (!adoptedAt) return 0;
  const adoptedMs = Date.parse(adoptedAt);
  if (Number.isNaN(adoptedMs)) return 0;
  const nowMs = (now ?? (() => Date.now()))();
  const diffMs = Math.max(0, nowMs - adoptedMs);
  return diffMs / (1000 * 60 * 60 * 24);
}

/**
 * Fraction of the UI under visual-regression monitoring for this binding,
 * derived from approved baselines in `visual_regression_results`.
 *
 * Definition (§A.5 proxy): `approvedBaselines / totalBaselines`. Returns
 * 0 when no history exists (bootstrap protection: avoids over-crediting
 * readiness when the monitor hasn't run yet).
 */
export function computeBaselineCoverage(store: StateStore, bindingName: string): number {
  const history = store.getVisualRegressionResults(bindingName, 1000);
  if (history.length === 0) return 0;
  const approved = history.filter((r) => Boolean(r.approved)).length;
  return approved / history.length;
}

function normalizeCoverage(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return 0;
  const clamped = value > 1 ? value / 100 : value;
  return Math.min(1, Math.max(0, clamped));
}
