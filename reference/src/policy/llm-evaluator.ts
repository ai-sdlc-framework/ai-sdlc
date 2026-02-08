/**
 * LLM evaluation gates.
 * Defines interfaces and evaluation logic for LLM output quality assessment.
 */

export type LLMEvaluationDimension =
  | 'factuality'
  | 'hallucination'
  | 'relevance'
  | 'toxicity'
  | 'bias'
  | 'completeness';

export interface LLMEvaluationResult {
  dimension: LLMEvaluationDimension;
  score: number;
  confidence: number;
  explanation?: string;
}

export interface LLMEvaluator {
  /** Evaluate content across the specified dimensions. */
  evaluate(content: string, dimensions: LLMEvaluationDimension[]): Promise<LLMEvaluationResult[]>;
}

export interface LLMEvaluationRule {
  dimensions: LLMEvaluationDimension[];
  thresholds: Partial<Record<LLMEvaluationDimension, number>>;
}

export interface LLMGateVerdict {
  passed: boolean;
  results: LLMEvaluationResult[];
  failures: Array<{
    dimension: LLMEvaluationDimension;
    score: number;
    threshold: number;
  }>;
}

/**
 * Evaluate an LLM evaluation rule against content.
 * Each dimension must meet or exceed its threshold to pass.
 */
export async function evaluateLLMRule(
  rule: LLMEvaluationRule,
  content: string,
  evaluator: LLMEvaluator,
): Promise<LLMGateVerdict> {
  const results = await evaluator.evaluate(content, rule.dimensions);
  const failures: LLMGateVerdict['failures'] = [];

  for (const result of results) {
    const threshold = rule.thresholds[result.dimension];
    if (threshold !== undefined && result.score < threshold) {
      failures.push({
        dimension: result.dimension,
        score: result.score,
        threshold,
      });
    }
  }

  // Also check for missing dimensions that have thresholds
  for (const [dimension, threshold] of Object.entries(rule.thresholds)) {
    const dim = dimension as LLMEvaluationDimension;
    const hasResult = results.some((r) => r.dimension === dim);
    if (!hasResult && threshold !== undefined) {
      failures.push({ dimension: dim, score: 0, threshold });
    }
  }

  return {
    passed: failures.length === 0,
    results,
    failures,
  };
}

/**
 * Create a stub LLM evaluator with preconfigured results.
 * Useful for testing without an actual LLM backend.
 */
export function createStubLLMEvaluator(preconfiguredResults: LLMEvaluationResult[]): LLMEvaluator {
  return {
    async evaluate(
      _content: string,
      dimensions: LLMEvaluationDimension[],
    ): Promise<LLMEvaluationResult[]> {
      return preconfiguredResults.filter((r) => dimensions.includes(r.dimension));
    },
  };
}
