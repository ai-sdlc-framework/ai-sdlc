/**
 * Meta-review pass — filters medium-confidence findings through a
 * lightweight LLM call (Haiku) to reduce false positives.
 *
 * Flow:
 *   High confidence (>0.8)  → post directly
 *   Medium (0.5-0.8)        → meta-review decides keep/drop
 *   Low (<0.5)              → already suppressed by parseVerdict()
 */

import type { ReviewVerdict, ReviewFinding } from './runners/review-agent.js';

// ── Thresholds ───────────────────────────────────────────────────────

const HIGH_CONFIDENCE = 0.8;

// ── Meta-review types ────────────────────────────────────────────────

export interface MetaReviewDecision {
  keep: boolean;
  adjustedSeverity?: ReviewFinding['severity'];
  reason: string;
}

export interface MetaReviewResult {
  /** The filtered verdict with medium-confidence findings reviewed. */
  verdict: ReviewVerdict;
  /** Decisions for each medium-confidence finding. */
  decisions: Array<{ finding: ReviewFinding; decision: MetaReviewDecision }>;
  /** Count of findings suppressed by meta-review. */
  suppressed: number;
}

// ── Meta-reviewer ────────────────────────────────────────────────────

/**
 * Run a meta-review pass on medium-confidence findings.
 *
 * @param verdict - The original verdict from a review agent
 * @param principles - Review principles text for context
 * @param callLLM - Function to make a single-turn LLM call (injectable for testing)
 */
export async function metaReview(
  verdict: ReviewVerdict,
  principles: string,
  callLLM: (prompt: string) => Promise<string>,
): Promise<MetaReviewResult> {
  const highConfidence: ReviewFinding[] = [];
  const mediumConfidence: ReviewFinding[] = [];

  for (const finding of verdict.findings) {
    const conf = finding.confidence ?? 1.0; // legacy findings without confidence pass through
    if (conf >= HIGH_CONFIDENCE) {
      highConfidence.push(finding);
    } else {
      mediumConfidence.push(finding);
    }
  }

  // If no medium-confidence findings, return as-is
  if (mediumConfidence.length === 0) {
    return {
      verdict,
      decisions: [],
      suppressed: 0,
    };
  }

  // Review each medium-confidence finding
  const decisions: Array<{ finding: ReviewFinding; decision: MetaReviewDecision }> = [];
  const kept: ReviewFinding[] = [...highConfidence];

  for (const finding of mediumConfidence) {
    try {
      const decision = await reviewSingleFinding(finding, principles, callLLM);
      decisions.push({ finding, decision });

      if (decision.keep) {
        kept.push({
          ...finding,
          severity: decision.adjustedSeverity ?? finding.severity,
        });
      }
    } catch {
      // Meta-review failure = keep the finding (conservative)
      kept.push(finding);
      decisions.push({
        finding,
        decision: { keep: true, reason: 'Meta-review failed, keeping conservatively' },
      });
    }
  }

  return {
    verdict: {
      ...verdict,
      findings: kept,
      // If all findings were suppressed, approve
      approved: kept.length === 0 ? true : verdict.approved,
    },
    decisions,
    suppressed: Math.max(0, mediumConfidence.length - (kept.length - highConfidence.length)),
  };
}

async function reviewSingleFinding(
  finding: ReviewFinding,
  principles: string,
  callLLM: (prompt: string) => Promise<string>,
): Promise<MetaReviewDecision> {
  const prompt = `You are a meta-reviewer evaluating whether a code review finding should be posted to a pull request.

## Review Principles
${principles}

## Finding to evaluate
- Severity: ${finding.severity}
- Confidence: ${finding.confidence}
- Category: ${finding.category ?? 'unknown'}
- File: ${finding.file ?? 'N/A'}
- Message: ${finding.message}
${finding.evidence?.failureScenario ? `- Failure scenario: ${finding.evidence.failureScenario}` : '- No failure scenario provided'}
${finding.evidence?.codePathTraced ? `- Code path: ${finding.evidence.codePathTraced}` : ''}

## Decision criteria
- Is this a real issue or noise?
- Does the evidence support the severity?
- Would a senior engineer flag this?
- Is this something CI already catches?

Respond with ONLY a JSON object:
{"keep": true/false, "adjustedSeverity": "critical|major|minor|suggestion" (optional), "reason": "brief explanation"}`;

  const response = await callLLM(prompt);

  // Parse response
  const cleaned = response.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '');
  const parsed = JSON.parse(cleaned);

  return {
    keep: Boolean(parsed.keep),
    adjustedSeverity: parsed.adjustedSeverity ?? undefined,
    reason: String(parsed.reason ?? ''),
  };
}

// ── Feedback tracking ────────────────────────────────────────────────

export interface ReviewFeedback {
  /** PR number. */
  prNumber: number;
  /** Finding that was posted. */
  finding: ReviewFinding;
  /** Human response. */
  signal: 'accepted' | 'dismissed' | 'ignored';
  /** Timestamp. */
  timestamp: string;
}

/**
 * Store for tracking human feedback on review findings.
 * Used to calibrate confidence thresholds over time.
 */
export class ReviewFeedbackStore {
  private entries: ReviewFeedback[] = [];

  record(feedback: ReviewFeedback): void {
    this.entries.push(feedback);
  }

  /** Get all feedback entries. */
  getAll(): ReviewFeedback[] {
    return [...this.entries];
  }

  /** Get precision: accepted / (accepted + dismissed). */
  precision(): number {
    const accepted = this.entries.filter((e) => e.signal === 'accepted').length;
    const dismissed = this.entries.filter((e) => e.signal === 'dismissed').length;
    const total = accepted + dismissed;
    return total === 0 ? 1.0 : accepted / total;
  }

  /** Get feedback by category. */
  byCategory(): Record<string, { accepted: number; dismissed: number; ignored: number }> {
    const result: Record<string, { accepted: number; dismissed: number; ignored: number }> = {};
    for (const entry of this.entries) {
      const cat = entry.finding.category ?? 'other';
      if (!result[cat]) result[cat] = { accepted: 0, dismissed: 0, ignored: 0 };
      result[cat][entry.signal]++;
    }
    return result;
  }

  /** Categories with high false-positive rate (dismissed > 50%). */
  highFalsePositiveCategories(): string[] {
    const cats = this.byCategory();
    return Object.entries(cats)
      .filter(([, v]) => {
        const total = v.accepted + v.dismissed;
        return total >= 3 && v.dismissed / total > 0.5;
      })
      .map(([k]) => k);
  }
}
