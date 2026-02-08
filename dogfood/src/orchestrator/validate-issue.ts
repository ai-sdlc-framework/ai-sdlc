/**
 * Validates a GitHub issue against quality gates using the reference
 * implementation's enforcement engine.
 */

import {
  enforce,
  type EvaluationContext,
  type EnforcementResult,
  type QualityGate,
  type Issue,
} from '@ai-sdlc/reference';

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
    repository: 'ai-sdlc-framework/ai-sdlc',
    metrics: {
      'description-length': hasDescription,
      'has-acceptance-criteria': hasAcceptanceCriteria,
      complexity,
    },
  };
}

/**
 * Validate an issue against the loaded QualityGate resource.
 */
export function validateIssue(issue: Issue, qualityGate: QualityGate): EnforcementResult {
  const ctx = buildEvaluationContext(issue);
  return enforce(qualityGate, ctx);
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
