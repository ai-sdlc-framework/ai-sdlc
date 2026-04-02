/**
 * PR Review orchestrator — thin wrapper around ReviewAgentRunner
 * that handles context assembly and verdict extraction.
 */

import {
  ReviewAgentRunner,
  type ReviewType,
  type ReviewVerdict,
  type ReviewAgentConfig,
} from './runners/review-agent.js';
import { metaReview } from './review-meta.js';
import type { Logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ReviewContext {
  issueTitle: string;
  issueBody: string;
  acceptanceCriteria?: string;
}

export interface ReviewOptions {
  /** Anthropic API config overrides. */
  apiConfig?: Omit<ReviewAgentConfig, 'reviewType'>;
  /** Logger for diagnostic output. */
  logger?: Logger;
  /** Inject runner for testing. */
  runner?: ReviewAgentRunner;
  /** Review principles text for meta-review context. */
  principles?: string;
  /** LLM caller for meta-review pass. If provided, medium-confidence findings are filtered. */
  metaReviewLLM?: (prompt: string) => Promise<string>;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Execute a single review agent against a PR diff.
 *
 * @param prNumber - PR number (for logging/identification)
 * @param diff - The full PR diff text
 * @param reviewType - Which review perspective (testing, critic, security)
 * @param context - Issue context for the review
 * @param options - Optional configuration overrides
 * @returns Review verdict with findings
 */
export async function executeReview(
  prNumber: number,
  diff: string,
  reviewType: ReviewType,
  context: ReviewContext,
  options?: ReviewOptions,
): Promise<ReviewVerdict> {
  const logger = options?.logger;

  logger?.info?.(`Starting ${reviewType} review for PR #${prNumber}`);

  const runner =
    options?.runner ??
    new ReviewAgentRunner({
      ...options?.apiConfig,
      reviewType,
    });

  const result = await runner.run({
    issueId: `PR-${prNumber}`,
    issueNumber: prNumber,
    issueTitle: context.issueTitle,
    issueBody: diff,
    workDir: '',
    branch: '',
    constraints: {
      maxFilesPerChange: 0,
      requireTests: false,
      blockedPaths: [],
    },
    // Reuse ciErrors field for acceptance criteria
    ciErrors: context.acceptanceCriteria,
  });

  if (!result.success) {
    logger?.error?.(`${reviewType} review failed: ${result.error}`);
    return {
      type: reviewType,
      approved: false,
      findings: [
        {
          severity: 'critical',
          message: `Review agent failed: ${result.error ?? 'unknown error'}`,
        },
      ],
      summary: `${reviewType} review could not be completed`,
    };
  }

  try {
    let verdict = JSON.parse(result.summary) as ReviewVerdict;
    verdict = { ...verdict, type: reviewType };

    // Run meta-review on medium-confidence findings if LLM caller provided
    if (options?.metaReviewLLM && options?.principles) {
      const metaResult = await metaReview(verdict, options.principles, options.metaReviewLLM);
      if (metaResult.suppressed > 0) {
        logger?.info?.(`${reviewType} meta-review: ${metaResult.suppressed} finding(s) suppressed`);
      }
      verdict = metaResult.verdict;
    }

    logger?.info?.(
      `${reviewType} review complete: ${verdict.approved ? 'APPROVED' : 'CHANGES REQUESTED'} (${verdict.findings.length} findings)`,
    );
    return verdict;
  } catch {
    logger?.error?.(`Failed to parse ${reviewType} verdict from runner output`);
    return {
      type: reviewType,
      approved: false,
      findings: [
        {
          severity: 'critical',
          message: 'Failed to parse review verdict from runner output',
        },
      ],
      summary: `${reviewType} review verdict was not valid JSON`,
    };
  }
}
