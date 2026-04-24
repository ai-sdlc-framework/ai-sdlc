/**
 * DesignQualityTrendDegrading detector (RFC-0008 Addendum A §A.8).
 *
 * Periodic monitor that analyses rolling windows over
 * `code_area_metrics` (designMetricsJson) and `token_compliance_history`
 * to catch degradation *before* it shows up in the admission hot path
 * via the C3 defect-risk factor. Emits one event per code area on
 * first detection and is hysteretic — does not re-fire until recovery.
 */

import type { DesignSystemBinding } from '@ai-sdlc/reference';
import type { StateStore } from './state/store.js';
import type { CodeAreaMetricsRecord, TokenComplianceRecord } from './state/types.js';

// ── Thresholds + config ────────────────────────────────────────────────

export interface TrendAnalysisConfig {
  /** Minimum number of data points in the recent window. */
  windowPrs: number;
  /** Maximum age of measurements to include (days). */
  windowDays: number;
  /** Drop in designCIPassRate (absolute) that triggers the condition. */
  ciDropThreshold: number;
  /** Rise in designReviewRejectionRate (absolute) that triggers. */
  reviewIncreaseThreshold: number;
  /** Minimum consecutive 'declining' compliance trends to trigger. */
  consecutiveNegativeCompliance: number;
}

export const DEFAULT_TREND_CONFIG: TrendAnalysisConfig = {
  windowPrs: 10,
  windowDays: 30,
  ciDropThreshold: 0.15,
  reviewIncreaseThreshold: 0.2,
  consecutiveNegativeCompliance: 5,
};

export type TrendCondition =
  | 'designCIPassRate'
  | 'designReviewRejectionRate'
  | 'tokenComplianceTrend';

// ── Parsed design metrics blob ─────────────────────────────────────────

interface DesignMetricsBlob {
  designCIPassRate?: number;
  designReviewRejectionRate?: number;
  usabilitySimPassRate?: number;
}

function parseDesignMetrics(json: string | undefined): DesignMetricsBlob | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as DesignMetricsBlob;
  } catch {
    return undefined;
  }
}

// ── Window selection ───────────────────────────────────────────────────

/**
 * Partition the history into `recent` (newest `windowPrs` records or
 * anything inside `windowDays`) and `baseline` (everything older). The
 * recent window fills by whichever bound hits first — that gives us a
 * consistent signal whether activity is sparse or bursty.
 *
 * History is assumed to be in descending `computed_at` order (as returned
 * by `getCodeAreaMetricsHistory`).
 */
export function splitHistoryByWindow<T extends { computedAt?: string }>(
  history: readonly T[],
  config: Pick<TrendAnalysisConfig, 'windowPrs' | 'windowDays'>,
  nowMs: number,
): { recent: T[]; baseline: T[] } {
  const cutoffMs = nowMs - config.windowDays * 24 * 60 * 60 * 1000;
  const recent: T[] = [];
  for (const row of history) {
    if (recent.length >= config.windowPrs) break;
    const ts = row.computedAt ? Date.parse(row.computedAt) : NaN;
    if (Number.isNaN(ts)) continue;
    if (ts < cutoffMs) break;
    recent.push(row);
  }
  const baseline = history.slice(recent.length);
  return { recent, baseline };
}

// ── Condition detection ────────────────────────────────────────────────

export interface ConditionEvaluation {
  triggered: boolean;
  recentValue?: number;
  baselineValue?: number;
  delta?: number;
}

export function evaluateCiPassRate(
  recent: readonly CodeAreaMetricsRecord[],
  baseline: readonly CodeAreaMetricsRecord[],
  threshold: number,
): ConditionEvaluation {
  const recentMean = meanDesignMetric(recent, 'designCIPassRate');
  const baselineMean = meanDesignMetric(baseline, 'designCIPassRate');
  if (recentMean === undefined || baselineMean === undefined) {
    return { triggered: false };
  }
  const delta = baselineMean - recentMean; // positive ⇒ dropped
  return {
    triggered: delta >= threshold,
    recentValue: recentMean,
    baselineValue: baselineMean,
    delta,
  };
}

export function evaluateReviewRejectionRate(
  recent: readonly CodeAreaMetricsRecord[],
  baseline: readonly CodeAreaMetricsRecord[],
  threshold: number,
): ConditionEvaluation {
  const recentMean = meanDesignMetric(recent, 'designReviewRejectionRate');
  const baselineMean = meanDesignMetric(baseline, 'designReviewRejectionRate');
  if (recentMean === undefined || baselineMean === undefined) {
    return { triggered: false };
  }
  const delta = recentMean - baselineMean; // positive ⇒ rejections rising
  return {
    triggered: delta >= threshold,
    recentValue: recentMean,
    baselineValue: baselineMean,
    delta,
  };
}

export function evaluateTokenComplianceTrend(
  history: readonly TokenComplianceRecord[],
  minConsecutive: number,
): ConditionEvaluation {
  // history is descending (newest first). Walk newest→oldest, counting
  // a run of declining coverages.
  let streak = 0;
  for (let i = 0; i < history.length - 1; i++) {
    if (history[i].coveragePercent < history[i + 1].coveragePercent) streak++;
    else break;
  }
  return {
    triggered: streak >= minConsecutive,
    recentValue: streak,
  };
}

function meanDesignMetric(
  rows: readonly CodeAreaMetricsRecord[],
  key: keyof DesignMetricsBlob,
): number | undefined {
  const values: number[] = [];
  for (const row of rows) {
    const blob = parseDesignMetrics(row.designMetricsJson);
    const value = blob?.[key];
    if (typeof value === 'number' && !Number.isNaN(value)) values.push(value);
  }
  if (values.length === 0) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ── Aggregate analysis ─────────────────────────────────────────────────

export interface TrendAnalysisResult {
  codeArea: string;
  triggered: boolean;
  conditions: Partial<Record<TrendCondition, ConditionEvaluation>>;
}

export function analyzeTrend(
  codeArea: string,
  codeAreaHistory: readonly CodeAreaMetricsRecord[],
  tokenComplianceHistory: readonly TokenComplianceRecord[],
  nowMs: number,
  overrides: Partial<TrendAnalysisConfig> = {},
): TrendAnalysisResult {
  const config = { ...DEFAULT_TREND_CONFIG, ...overrides };
  const { recent, baseline } = splitHistoryByWindow(codeAreaHistory, config, nowMs);

  const ci = evaluateCiPassRate(recent, baseline, config.ciDropThreshold);
  const review = evaluateReviewRejectionRate(recent, baseline, config.reviewIncreaseThreshold);
  const compliance = evaluateTokenComplianceTrend(
    tokenComplianceHistory,
    config.consecutiveNegativeCompliance,
  );

  const conditions: TrendAnalysisResult['conditions'] = {};
  if (ci.triggered) conditions.designCIPassRate = ci;
  if (review.triggered) conditions.designReviewRejectionRate = review;
  if (compliance.triggered) conditions.tokenComplianceTrend = compliance;

  return {
    codeArea,
    triggered: Object.keys(conditions).length > 0,
    conditions,
  };
}

// ── Event + detector ───────────────────────────────────────────────────

export interface DesignQualityTrendDegradingEvent {
  type: 'DesignQualityTrendDegrading';
  codeArea: string;
  bindingName?: string;
  triggeredAt: string;
  triggeredConditions: TrendCondition[];
  conditions: TrendAnalysisResult['conditions'];
  notifiedPrincipals: string[];
  issueBodyMarkdown: string;
}

export interface DesignQualityTrendDetectorDeps {
  stateStore: StateStore;
  /** Resolve a code area to its owning DSB, if any. */
  getBindingForCodeArea?: (codeArea: string) => DesignSystemBinding | undefined;
  /** Timestamp of the last emission for this area (hysteresis state). */
  getLastTriggerAt?: (codeArea: string) => string | undefined;
  /** Required quiet window (ms) with no trigger before re-firing. */
  hysteresisRecoveryMs?: number;
  /** Clock injection (defaults to `Date.now`). */
  now?: () => number;
  /** Partial config override. */
  config?: Partial<TrendAnalysisConfig>;
}

/**
 * Run the trend analysis for one code area. Returns an event when the
 * trend is currently degrading AND the hysteresis quiet window has
 * elapsed since the last trigger (or no prior trigger). Returns
 * undefined otherwise.
 */
export function detectDesignQualityTrendDegrading(
  codeArea: string,
  deps: DesignQualityTrendDetectorDeps,
): DesignQualityTrendDegradingEvent | undefined {
  const nowMs = (deps.now ?? (() => Date.now()))();

  // Hysteresis: skip if we've emitted recently within the recovery window.
  const lastTriggerAt = deps.getLastTriggerAt?.(codeArea);
  if (lastTriggerAt) {
    const lastMs = Date.parse(lastTriggerAt);
    const recoveryMs = deps.hysteresisRecoveryMs ?? 7 * 24 * 60 * 60 * 1000; // 7d default
    if (!Number.isNaN(lastMs) && nowMs - lastMs < recoveryMs) return undefined;
  }

  const history = deps.stateStore.getCodeAreaMetricsHistory(codeArea, { limit: 100 });
  const binding = deps.getBindingForCodeArea?.(codeArea);
  const tokenHistory = binding
    ? deps.stateStore.getTokenComplianceHistory(binding.metadata.name)
    : [];

  const result = analyzeTrend(codeArea, history, tokenHistory, nowMs, deps.config);
  if (!result.triggered) return undefined;

  const principals = binding ? gatherPrincipals(binding) : [];
  const triggeredConditions = Object.keys(result.conditions) as TrendCondition[];

  return {
    type: 'DesignQualityTrendDegrading',
    codeArea,
    bindingName: binding?.metadata.name,
    triggeredAt: new Date(nowMs).toISOString(),
    triggeredConditions,
    conditions: result.conditions,
    notifiedPrincipals: principals,
    issueBodyMarkdown: renderIssueBody(result, binding),
  };
}

function gatherPrincipals(binding: DesignSystemBinding): string[] {
  const design = binding.spec.stewardship.designAuthority.principals;
  const engineering = binding.spec.stewardship.engineeringAuthority.principals;
  const unique = new Set<string>([...design, ...engineering]);
  return Array.from(unique);
}

function renderIssueBody(result: TrendAnalysisResult, binding?: DesignSystemBinding): string {
  const lines = [
    `## DesignQualityTrendDegrading — ${result.codeArea}`,
    '',
    binding
      ? `Linked DesignSystemBinding: **${binding.metadata.name}**`
      : 'No linked DesignSystemBinding',
    '',
    '### Triggered conditions',
    '',
  ];
  for (const [name, evaluation] of Object.entries(result.conditions)) {
    const baseline =
      evaluation.baselineValue !== undefined ? evaluation.baselineValue.toFixed(3) : 'n/a';
    const current =
      evaluation.recentValue !== undefined ? evaluation.recentValue.toFixed(3) : 'n/a';
    const delta = evaluation.delta !== undefined ? evaluation.delta.toFixed(3) : 'n/a';
    lines.push(`- **${name}** — baseline ${baseline}, recent ${current}, delta ${delta}`);
  }
  lines.push('', '---', 'Investigate the code area and file follow-up tasks as needed.');
  return lines.join('\n');
}
