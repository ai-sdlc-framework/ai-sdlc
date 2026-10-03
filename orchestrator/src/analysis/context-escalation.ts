/**
 * Context Escalation — implements summary-first retrieval strategy.
 * 
 * Instead of immediately giving Claude everything:
 * 1. Send summary only
 * 2. Identify what is needed
 * 3. Retrieve detailed context only when necessary
 *
 * This prevents token waste on context the agent doesn't need.
 */

export interface ContextSummary {
  fileCount: number;
  testCount: number;
  acceptanceCriteriaCount: number;
  referenceCount: number;
  hasNewDependencies: boolean;
  hasSchemaChanges: boolean;
  estimatedComplexity: 'low' | 'medium' | 'high';
}

export interface EscalationRequest {
  type: 'full-diff' | 'test-details' | 'schema-history' | 'dependency-analysis';
  rationale: string;
}

/**
 * Build a lightweight summary instead of sending full context.
 * Agent escalates if it needs details.
 */
export function buildContextSummary(
  filesChanged: number,
  testsChanged: number,
  acceptanceCriteria: string[],
  references: string[],
  newDependencies: boolean,
  schemaChanges: boolean,
): ContextSummary {
  return {
    fileCount: filesChanged,
    testCount: testsChanged,
    acceptanceCriteriaCount: acceptanceCriteria.length,
    referenceCount: references.length,
    hasNewDependencies: newDependencies,
    hasSchemaChanges: schemaChanges,
    estimatedComplexity: estimateComplexity(
      filesChanged,
      testsChanged,
      newDependencies,
      schemaChanges,
    ),
  };
}

/**
 * Estimate task complexity from surface-level metrics.
 */
function estimateComplexity(
  filesChanged: number,
  testsChanged: number,
  newDependencies: boolean,
  schemaChanges: boolean,
): 'low' | 'medium' | 'high' {
  let score = 0;

  score += Math.min(filesChanged / 5, 3); // Up to 3 points for file count
  score += Math.min(testsChanged / 3, 2); // Up to 2 points for test count
  if (newDependencies) score += 2;
  if (schemaChanges) score += 3;

  if (score >= 7) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

/**
 * Format summary as a lightweight prompt section.
 */
export function formatSummaryForPrompt(summary: ContextSummary): string {
  const lines = [
    '## Task Context Summary (lightweight)',
    '',
    '### Scope',
    `- Files changed: ${summary.fileCount}`,
    `- Tests touched: ${summary.testCount}`,
    `- Complexity: ${summary.estimatedComplexity}`,
    '',
    '### Acceptance Criteria & References',
    `- Criteria: ${summary.acceptanceCriteriaCount} items`,
    `- References: ${summary.referenceCount} items`,
    '',
    '### Special Considerations',
    summary.hasNewDependencies ? '- ⚠️  New dependencies added' : '- No new dependencies',
    summary.hasSchemaChanges ? '- ⚠️  Schema changes detected' : '- No schema changes',
    '',
    '### Note',
    'If you need full diff details, test file contents, or dependency analysis,',
    'escalate explicitly in your response and we will provide them on request.',
  ];

  return lines.join('\n');
}

/**
 * Parse escalation request from agent response.
 * Agents can ask for additional context when needed.
 */
export function parseEscalationRequest(response: string): EscalationRequest | null {
  // Look for patterns like: ESCALATE: full-diff because...
  const match = response.match(
    /ESCALATE:\s*(full-diff|test-details|schema-history|dependency-analysis)\s+because\s+(.+?)(?:\n|$)/i,
  );

  if (!match) return null;

  return {
    type: match[1] as any,
    rationale: match[2].trim(),
  };
}
