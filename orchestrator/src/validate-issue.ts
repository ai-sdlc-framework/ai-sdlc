/**
 * Validates a GitHub issue against quality gates using the reference
 * implementation's enforcement engine, with optional expression and LLM
 * evaluation extensions.
 */

import {
  enforce,
  evaluateExpressionRule,
  evaluateLLMRule,
  type EvaluationContext,
  type EnforcementResult,
  type QualityGate,
  type Issue,
  type ExpressionEvaluator,
  type ExpressionRule,
  type LLMEvaluator,
  type LLMEvaluationRule,
} from '@ai-sdlc/reference';
import { DEFAULT_GITHUB_REPOSITORY } from './defaults.js';

/**
 * Build an EvaluationContext from an issue, mapping issue metadata
 * to the metrics expected by the quality gate rules.
 */
function buildEvaluationContext(issue: Issue): EvaluationContext {
  const hasDescription = issue.description ? issue.description.trim().length : 0;

  const hasAcceptanceCriteria = issue.description
    ? /## Acceptance Criteria/i.test(issue.description)
      ? 1
      : 0
    : 0;

  const complexityMatch = issue.description?.match(/### Complexity\s*\n+\s*(\d+)/i);
  const complexity = complexityMatch ? Number(complexityMatch[1]) : 0;

  return {
    authorType: 'ai-agent',
    repository: DEFAULT_GITHUB_REPOSITORY,
    metrics: {
      'description-length': hasDescription,
      'has-acceptance-criteria': hasAcceptanceCriteria,
      complexity,
    },
  };
}

/**
 * Validate an issue against the loaded QualityGate resource.
 * An optional enforceFn can be provided (e.g. instrumented enforcement).
 */
export function validateIssue(
  issue: Issue,
  qualityGate: QualityGate,
  enforceFn?: typeof enforce,
): EnforcementResult {
  const ctx = buildEvaluationContext(issue);
  return (enforceFn ?? enforce)(qualityGate, ctx);
}

/**
 * Extended validation that also evaluates expression and LLM gate rules.
 */
export async function validateIssueWithExtensions(
  issue: Issue,
  qualityGate: QualityGate,
  options?: {
    expressionEvaluator?: ExpressionEvaluator;
    llmEvaluator?: LLMEvaluator;
  },
): Promise<EnforcementResult> {
  // Start with standard enforcement
  const result = validateIssue(issue, qualityGate);

  // Evaluate expression rules from quality gates
  if (options?.expressionEvaluator) {
    const ctx = buildEvaluationContext(issue);
    for (const gate of qualityGate.spec.gates) {
      if ('expression' in gate.rule) {
        const verdict = evaluateExpressionRule(
          gate.rule as ExpressionRule,
          { ctx },
          options.expressionEvaluator,
        );
        if (!verdict.passed) {
          result.allowed = false;
          result.results.push({
            gate: gate.name,
            verdict: 'fail',
            enforcement: gate.enforcement,
            message:
              verdict.message ??
              `Expression rule failed: ${(gate.rule as ExpressionRule).expression}`,
          });
        }
      }
    }
  }

  // Evaluate LLM rules on issue description
  if (options?.llmEvaluator && issue.description) {
    for (const gate of qualityGate.spec.gates) {
      // Check for LLM evaluation rule pattern (has dimensions and thresholds)
      const rule = gate.rule as unknown as Record<string, unknown>;
      if ('dimensions' in rule && 'thresholds' in rule) {
        const llmVerdict = await evaluateLLMRule(
          rule as unknown as LLMEvaluationRule,
          issue.description,
          options.llmEvaluator,
        );
        if (!llmVerdict.passed) {
          result.allowed = false;
          const failureDetails = llmVerdict.failures
            .map((f) => `${f.dimension}: ${f.score.toFixed(2)} < ${f.threshold}`)
            .join(', ');
          result.results.push({
            gate: gate.name,
            verdict: 'fail',
            enforcement: gate.enforcement,
            message: `LLM evaluation failed: ${failureDetails}`,
          });
        }
      }
    }
  }

  return result;
}

/**
 * Parse complexity from issue body (GitHub issue template format).
 * Returns 0 if not found.
 */
export function parseComplexity(issueBody: string | undefined): number {
  if (!issueBody) return 0;
  const match = issueBody.match(/### Complexity\s*\n+\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
}
