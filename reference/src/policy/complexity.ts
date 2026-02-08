/**
 * Complexity scoring and routing from PRD Section 12.3.
 *
 * Scores tasks 1-10 and maps to routing strategies:
 * - 1-3: fully-autonomous
 * - 4-6: ai-with-review
 * - 7-8: ai-assisted
 * - 9-10: human-led
 */

import type { ComplexityThreshold, RoutingStrategy } from '../core/types.js';

export interface ComplexityInput {
  filesAffected: number;
  linesOfChange: number;
  securitySensitive?: boolean;
  apiChange?: boolean;
  databaseMigration?: boolean;
  crossServiceChange?: boolean;
  newDependencies?: number;
}

export interface ComplexityFactor {
  name: string;
  weight: number;
  score: (input: ComplexityInput) => number;
}

export interface ComplexityResult {
  score: number;
  factors: Record<string, number>;
  strategy: RoutingStrategy;
}

export const DEFAULT_COMPLEXITY_FACTORS: readonly ComplexityFactor[] = [
  {
    name: 'fileScope',
    weight: 0.2,
    score: (input) => Math.min(10, Math.ceil(input.filesAffected / 5)),
  },
  {
    name: 'changeSize',
    weight: 0.2,
    score: (input) => Math.min(10, Math.ceil(input.linesOfChange / 100)),
  },
  {
    name: 'security',
    weight: 0.2,
    score: (input) => (input.securitySensitive ? 10 : 1),
  },
  {
    name: 'apiChange',
    weight: 0.15,
    score: (input) => (input.apiChange ? 8 : 1),
  },
  {
    name: 'databaseMigration',
    weight: 0.15,
    score: (input) => (input.databaseMigration ? 9 : 1),
  },
  {
    name: 'crossService',
    weight: 0.1,
    score: (input) => (input.crossServiceChange ? 8 : 1),
  },
];

export const DEFAULT_THRESHOLDS: Record<string, ComplexityThreshold> = {
  low: { min: 1, max: 3, strategy: 'fully-autonomous' },
  medium: { min: 4, max: 6, strategy: 'ai-with-review' },
  high: { min: 7, max: 8, strategy: 'ai-assisted' },
  critical: { min: 9, max: 10, strategy: 'human-led' },
};

/**
 * Score the complexity of a task based on weighted factors.
 * Returns a score between 1 and 10.
 */
export function scoreComplexity(
  input: ComplexityInput,
  factors: readonly ComplexityFactor[] = DEFAULT_COMPLEXITY_FACTORS,
): number {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const factor of factors) {
    const raw = Math.max(1, Math.min(10, factor.score(input)));
    weightedSum += raw * factor.weight;
    totalWeight += factor.weight;
  }

  if (totalWeight === 0) return 1;
  const score = Math.round(weightedSum / totalWeight);
  return Math.max(1, Math.min(10, score));
}

/**
 * Map a complexity score to a routing strategy using thresholds.
 */
export function routeByComplexity(
  score: number,
  thresholds: Record<string, ComplexityThreshold> = DEFAULT_THRESHOLDS,
): RoutingStrategy {
  for (const threshold of Object.values(thresholds)) {
    if (score >= threshold.min && score <= threshold.max) {
      return threshold.strategy;
    }
  }
  // Fallback: highest score means human-led
  return score >= 7 ? 'human-led' : 'ai-with-review';
}

/**
 * Score complexity and determine routing strategy in one call.
 */
export function evaluateComplexity(
  input: ComplexityInput,
  factors?: readonly ComplexityFactor[],
  thresholds?: Record<string, ComplexityThreshold>,
): ComplexityResult {
  const factorScores: Record<string, number> = {};
  const usedFactors = factors ?? DEFAULT_COMPLEXITY_FACTORS;

  for (const factor of usedFactors) {
    factorScores[factor.name] = Math.max(1, Math.min(10, factor.score(input)));
  }

  const score = scoreComplexity(input, usedFactors);
  const strategy = routeByComplexity(score, thresholds);

  return { score, factors: factorScores, strategy };
}
