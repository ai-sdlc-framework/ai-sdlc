/**
 * Autonomous correction loop for design system gates (RFC-0006 §8.4)
 * and Design Review feedback pipeline (RFC-0006 §8.5).
 */

import type { VisualRegressionFailure } from '@ai-sdlc/reference';

// ── Correction Loop ──────────────────────────────────────────────────

export interface CorrectionIteration {
  attempt: number;
  failures: VisualRegressionFailure[];
  codeDiff?: string;
  visualDiff?: string;
  costUsd: number;
  tokenReferencesChanged: boolean;
  timestamp: string;
}

export interface CorrectionLoopConfig {
  maxRetries: number;
  costSoftLimitUsd: number;
}

export type CorrectionExitReason =
  | 'max-retries'
  | 'token-reference-changed'
  | 'cost-limit-exceeded'
  | 'design-review-triggered'
  | 'success';

export interface CorrectionLoopResult {
  converged: boolean;
  exitReason: CorrectionExitReason;
  iterations: CorrectionIteration[];
  totalCostUsd: number;
}

/**
 * Check whether the correction loop should exit.
 */
export function checkExitConditions(
  iterations: CorrectionIteration[],
  config: CorrectionLoopConfig,
  designReviewTriggered: boolean,
): CorrectionExitReason | null {
  // Condition 1: maxRetries reached
  if (iterations.length >= config.maxRetries) {
    return 'max-retries';
  }

  // Condition 2: agent changed a token reference
  const last = iterations[iterations.length - 1];
  if (last?.tokenReferencesChanged) {
    return 'token-reference-changed';
  }

  // Condition 3: cumulative cost exceeds soft limit
  const totalCost = iterations.reduce((sum, it) => sum + it.costUsd, 0);
  if (totalCost >= config.costSoftLimitUsd) {
    return 'cost-limit-exceeded';
  }

  // Condition 4: design review trigger conditions met
  if (designReviewTriggered) {
    return 'design-review-triggered';
  }

  return null;
}

/**
 * Run the autonomous correction loop.
 *
 * @param runAttempt - Function that executes the agent and returns failures + cost
 * @param config - Loop configuration (maxRetries, cost limit)
 * @param checkDesignReviewTrigger - Function that checks if design review conditions are met
 */
export async function runCorrectionLoop(
  runAttempt: (
    failures: VisualRegressionFailure[],
    attempt: number,
  ) => Promise<{
    failures: VisualRegressionFailure[];
    costUsd: number;
    tokenReferencesChanged: boolean;
    codeDiff?: string;
  }>,
  config: CorrectionLoopConfig,
  checkDesignReviewTrigger: () => boolean = () => false,
): Promise<CorrectionLoopResult> {
  const iterations: CorrectionIteration[] = [];
  let currentFailures: VisualRegressionFailure[] = [];

  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    const result = await runAttempt(currentFailures, attempt);

    iterations.push({
      attempt,
      failures: result.failures,
      codeDiff: result.codeDiff,
      costUsd: result.costUsd,
      tokenReferencesChanged: result.tokenReferencesChanged,
      timestamp: new Date().toISOString(),
    });

    // Check if converged (no more failures)
    if (result.failures.length === 0) {
      return {
        converged: true,
        exitReason: 'success',
        iterations,
        totalCostUsd: iterations.reduce((s, it) => s + it.costUsd, 0),
      };
    }

    currentFailures = result.failures;

    // Check exit conditions
    const exitReason = checkExitConditions(iterations, config, checkDesignReviewTrigger());
    if (exitReason) {
      return {
        converged: false,
        exitReason,
        iterations,
        totalCostUsd: iterations.reduce((s, it) => s + it.costUsd, 0),
      };
    }
  }

  return {
    converged: false,
    exitReason: 'max-retries',
    iterations,
    totalCostUsd: iterations.reduce((s, it) => s + it.costUsd, 0),
  };
}

// ── Design Review Feedback Store (RFC-0006 §A.7) ────────────────────

export type FeedbackSignal = 'accepted' | 'dismissed' | 'overridden' | 'escalated';

export interface FeedbackEntry {
  prNumber: number;
  category: string;
  signal: FeedbackSignal;
  reviewer: string;
  comment?: string;
  timestamp: string;
}

export interface CategoryAnalysis {
  category: string;
  dismissRate: number;
}

export interface DesignReviewFeedbackStore {
  record(entry: FeedbackEntry): void;
  precision(): number;
  highFalsePositiveCategories(): CategoryAnalysis[];
  falseNegativeCategories(): CategoryAnalysis[];
  getEntries(): FeedbackEntry[];
}

export function createDesignReviewFeedbackStore(): DesignReviewFeedbackStore {
  const entries: FeedbackEntry[] = [];

  return {
    record(entry) {
      entries.push(entry);
    },

    precision() {
      const accepted = entries.filter((e) => e.signal === 'accepted').length;
      const dismissed = entries.filter((e) => e.signal === 'dismissed').length;
      const total = accepted + dismissed;
      return total > 0 ? accepted / total : 1;
    },

    highFalsePositiveCategories() {
      const categoryStats = new Map<string, { dismissed: number; total: number }>();

      for (const entry of entries) {
        const stats = categoryStats.get(entry.category) ?? { dismissed: 0, total: 0 };
        stats.total++;
        if (entry.signal === 'dismissed') stats.dismissed++;
        categoryStats.set(entry.category, stats);
      }

      return [...categoryStats.entries()]
        .map(([category, stats]) => ({
          category,
          dismissRate: stats.total > 0 ? stats.dismissed / stats.total : 0,
        }))
        .filter((c) => c.dismissRate > 0)
        .sort((a, b) => b.dismissRate - a.dismissRate);
    },

    falseNegativeCategories() {
      const categoryStats = new Map<string, { escalated: number; total: number }>();

      for (const entry of entries) {
        const stats = categoryStats.get(entry.category) ?? { escalated: 0, total: 0 };
        stats.total++;
        if (entry.signal === 'escalated') stats.escalated++;
        categoryStats.set(entry.category, stats);
      }

      return [...categoryStats.entries()]
        .map(([category, stats]) => ({
          category,
          dismissRate: stats.total > 0 ? stats.escalated / stats.total : 0,
        }))
        .filter((c) => c.dismissRate > 0)
        .sort((a, b) => b.dismissRate - a.dismissRate);
    },

    getEntries() {
      return [...entries];
    },
  };
}
