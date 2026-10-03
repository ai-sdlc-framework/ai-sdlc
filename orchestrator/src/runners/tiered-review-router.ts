/**
 * Tiered Review Router — routes PRs to appropriate review tier based on size/complexity.
 *
 * Current implementation reviews everything equally. This wastes tokens on
 * small, low-risk changes. Implement tiered approach:
 *
 * - Tier 1 (0-300 lines):   Lightweight (style, obvious bugs only)
 * - Tier 2 (301-600 lines): Standard review (logic, design, security)
 * - Tier 3 (601-1000):      Full review (comprehensive)
 * - Tier 4 (>1000):         Require splitting + full review each
 */

export type ReviewTier = 'lightweight' | 'standard' | 'full' | 'split-required';

export interface ReviewTierConfig {
  /** Threshold for lightweight review (default 300) */
  lightweightThreshold: number;
  /** Threshold for standard review (default 600) */
  standardThreshold: number;
  /** Threshold for full review (default 1000) */
  fullThreshold: number;
}

export interface PRMetrics {
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  testCoverageChange: number; // percentage points
  hasCriticalFiles: boolean; // auth, security, database
  hasSchemaChange: boolean;
}

/**
 * Determine review tier for a PR based on metrics.
 */
export function determineReviewTier(
  metrics: PRMetrics,
  config: Partial<ReviewTierConfig> = {},
): ReviewTier {
  const {
    lightweightThreshold = 300,
    standardThreshold = 600,
    fullThreshold = 1000,
  } = config;

  const totalLines = metrics.linesAdded + metrics.linesRemoved;

  // Escalate if critical files or schema changes
  if (metrics.hasCriticalFiles || metrics.hasSchemaChange) {
    if (totalLines > fullThreshold) return 'split-required';
    return 'full';
  }

  // Route by line count
  if (totalLines <= lightweightThreshold) return 'lightweight';
  if (totalLines <= standardThreshold) return 'standard';
  if (totalLines <= fullThreshold) return 'full';
  return 'split-required';
}

/**
 * Get review scope based on tier.
 * Lightweight reviews skip expensive checks.
 */
export function getReviewScope(tier: ReviewTier) {
  const scopes: Record<ReviewTier, string[]> = {
    lightweight: [
      'style-and-obvious-bugs',
      'acceptance-criteria',
      'test-existence', // Do tests exist? Not their quality.
    ],
    standard: [
      'logic-errors',
      'design-issues',
      'security-vulnerabilities',
      'error-handling',
      'test-coverage-and-quality',
      'acceptance-criteria',
    ],
    full: [
      'logic-errors',
      'design-issues',
      'security-vulnerabilities',
      'error-handling',
      'test-coverage-and-quality',
      'performance-issues',
      'race-conditions',
      'acceptance-criteria',
      'architectural-consistency',
    ],
    'split-required': [
      'require-split-into-smaller-prs',
    ],
  };

  return {
    tier,
    scope: scopes[tier],
    shouldBlock: tier === 'split-required',
    estimatedTokens: estimateTokensForTier(tier),
  };
}

/**
 * Estimate token usage for different review tiers.
 * Used for cost tracking and optimization.
 */
function estimateTokensForTier(tier: ReviewTier): number {
  const estimates: Record<ReviewTier, number> = {
    lightweight: 2000, // Minimal
    standard: 5000, // Moderate
    full: 12000, // Comprehensive
    'split-required': 0, // Blocked, require split
  };

  return estimates[tier];
}

/**
 * Format review scope as prompt instruction.
 */
export function formatReviewScopePrompt(tier: ReviewTier, scope: string[]): string {
  const lines = [
    `## Review Tier: ${tier.toUpperCase()}`,
    '',
    `This PR has been routed to **${tier}** review tier.`,
    '',
    '### Your Review Scope',
    'Focus on these areas:',
    scope.map((s) => `- ${s}`).join('\n'),
    '',
  ];

  if (tier === 'split-required') {
    lines.push(
      '⚠️  **This PR is too large.** Request the author to split it into smaller PRs',
      'and review each one separately.',
    );
  } else if (tier === 'lightweight') {
    lines.push(
      '**This is a small change.** Focus on style, obvious bugs, and acceptance criteria.',
      'Skip deep architectural analysis.',
    );
  }

  return lines.join('\n');
}
