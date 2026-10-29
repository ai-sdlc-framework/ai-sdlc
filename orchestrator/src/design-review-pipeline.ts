/**
 * Design review pipeline wiring (RFC-0006 Addendum A).
 *
 * Composes the structural preprocessor, exemplar bank, design metrics,
 * correction loop and trend detector into the entry points the pipeline
 * calls, so those modules are reachable at runtime.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  analyzeStructure,
  triggersDesignReview,
  createExemplarBank,
  parseExemplarsFromYaml,
  type ExemplarBank,
  type StructuralDesignAnalysis,
} from '@ai-sdlc/reference';
import type { VisualRegressionFailure } from '@ai-sdlc/reference';
import { computeDesignMetrics, type DesignMetrics } from './design-system-metrics.js';
import {
  runCorrectionLoop,
  type CorrectionLoopConfig,
  type CorrectionLoopResult,
} from './design-system-correction-loop.js';
import {
  detectDesignQualityTrendDegrading,
  type DesignQualityTrendDegradingEvent,
  type DesignQualityTrendDetectorDeps,
} from './design-quality-trend.js';
import type { StateStore } from './state/store.js';

/** Default location of the design exemplar bank. */
export const DESIGN_EXEMPLARS_PATH = '.ai-sdlc/design-review-exemplars.yaml';

/** Load the exemplar bank from YAML via parseExemplarsFromYaml(). */
export function loadDesignExemplarBank(path: string = DESIGN_EXEMPLARS_PATH): ExemplarBank {
  const data = parseYaml(readFileSync(path, 'utf8')) as Parameters<
    typeof parseExemplarsFromYaml
  >[0];
  return createExemplarBank(parseExemplarsFromYaml(data));
}

export interface DesignReviewContext {
  analysis: StructuralDesignAnalysis;
  /** True when the human design review step must run. */
  requiresHumanReview: boolean;
  /** Markdown to prepend to the design reviewer's context. */
  contextMarkdown: string;
}

/**
 * Run the structural preprocessor and build the reviewer context:
 * structural findings first, then the 7 principles and exemplars.
 */
export function buildDesignReviewContext(
  input: Parameters<typeof analyzeStructure>[0],
  bank: ExemplarBank,
): DesignReviewContext {
  const analysis = analyzeStructure(input);
  const requiresHumanReview = triggersDesignReview(analysis);
  const lines = [
    '## Structural analysis',
    `- Complexity score: ${analysis.complexityScore}/10`,
    `- Off-grid spacing values: ${analysis.spacingAnalysis.offGridValues}`,
    `- Hardcoded colours: ${analysis.colorAudit.hardcodedColors}`,
    `- Missing states: ${analysis.stateCoverage.missingStates.join(', ') || 'none'}`,
    `- Human design review required: ${requiresHumanReview ? 'yes' : 'no'}`,
    '',
    '## Design review principles',
    ...bank.getPrinciples().map((p) => `- ${p.id}`),
    '',
    '## Exemplars',
    ...bank
      .getAll()
      .map((e) => `- [${e.type}] ${e.id} (${e.principle}): ${e.scenario} => ${e.verdict}`),
  ];
  return { analysis, requiresHumanReview, contextMarkdown: lines.join('\n') };
}

/** Compute the six design metrics for a binding from the state store. */
export function computeBindingDesignMetrics(
  store: StateStore,
  bindingName: string,
  counts: Omit<
    Parameters<typeof computeDesignMetrics>[0],
    'reviewEvents' | 'complianceHistory' | 'visualRegressionResults' | 'usabilitySimulationResults'
  > = {},
): DesignMetrics {
  return computeDesignMetrics({
    reviewEvents: store.getDesignReviewEvents(bindingName),
    complianceHistory: store.getTokenComplianceHistory(bindingName),
    visualRegressionResults: store.getVisualRegressionResults(bindingName),
    usabilitySimulationResults: store.getUsabilitySimulationResults(bindingName),
    ...counts,
  });
}

/** Invoke the correction loop when a design gate fails. */
export function handleDesignGateFailure(
  runAttempt: Parameters<typeof runCorrectionLoop>[0],
  config: CorrectionLoopConfig,
  initialFailures: VisualRegressionFailure[],
  checkDesignReviewTrigger?: () => boolean,
): Promise<CorrectionLoopResult> {
  if (initialFailures.length === 0) {
    return Promise.resolve({
      converged: true,
      exitReason: 'success',
      iterations: [],
      totalCostUsd: 0,
    });
  }
  return runCorrectionLoop(
    (failures, attempt) => runAttempt(attempt === 0 ? initialFailures : failures, attempt),
    config,
    checkDesignReviewTrigger,
  );
}

/** Periodic monitor: run the trend detector over code areas. */
export function runDesignQualityTrendMonitor(
  codeAreas: string[],
  deps: DesignQualityTrendDetectorDeps,
): DesignQualityTrendDegradingEvent[] {
  const events: DesignQualityTrendDegradingEvent[] = [];
  for (const area of codeAreas) {
    const event = detectDesignQualityTrendDegrading(area, deps);
    if (event) events.push(event);
  }
  return events;
}
