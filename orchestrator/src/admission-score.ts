/**
 * Issue admission scoring — maps GitHub issue fields to PPA dimensions
 * and determines whether an issue should enter the pipeline.
 *
 * Extracted from dogfood/scripts/ppa-score.ts for reuse across CLI
 * scripts and workflows.
 */

import {
  computePriority,
  type PriorityInput,
  type PriorityScore,
  type PriorityConfig,
} from './priority.js';

// ── Types ────────────────────────────────────────────────────────────

export interface AdmissionInput {
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  /** Total thumbsUp + heart reactions. */
  reactionCount: number;
  /** Number of human comments. */
  commentCount: number;
  /** ISO timestamp of issue creation. */
  createdAt: string;
}

export interface AdmissionThresholds {
  minimumScore: number;
  minimumConfidence: number;
}

export interface IssueAdmissionResult {
  admitted: boolean;
  score: PriorityScore;
  reason: string;
  suggestions?: string[];
}

// ── Mapping ──────────────────────────────────────────────────────────

/**
 * Map GitHub issue fields to PPA PriorityInput dimensions.
 *
 * Heuristics (ported from dogfood/scripts/ppa-score.ts):
 * - Labels → bug severity, soul alignment hints, builder conviction
 * - Reactions → team consensus, customer request count
 * - Comments → demand signal
 * - Body complexity section → complexity score
 * - Issue age → competitive drift
 */
export function mapIssueToPriorityInput(input: AdmissionInput): PriorityInput {
  const labels = input.labels;

  // ── Complexity from issue body ───────────────────────────────
  const complexityMatch = input.body?.match(/###?\s*Complexity\s*\n+\s*(\d+)/i);
  const complexity = complexityMatch ? Number(complexityMatch[1]) : undefined;

  // ── Bug severity from labels ─────────────────────────────────
  let bugSeverity: number | undefined;
  if (labels.includes('critical') || labels.includes('P0')) bugSeverity = 5;
  else if (labels.includes('bug')) bugSeverity = 3;

  // ── Soul alignment heuristic from labels ─────────────────────
  let soulAlignment = 0.5;
  if (labels.includes('security') || labels.includes('security-triage')) soulAlignment = 0.7;
  if (labels.includes('enhancement')) soulAlignment = 0.6;
  if (labels.includes('governance') || labels.includes('compliance')) soulAlignment = 0.85;
  if (labels.includes('spec') || labels.includes('rfc')) soulAlignment = 0.9;

  // ── Reactions → demand / consensus ───────────────────────────
  const teamConsensus = Math.min(1, input.reactionCount / 5);

  // ── Comment count → demand signal ────────────────────────────
  const demandSignal = Math.min(1, input.commentCount / 5);

  // ── Builder conviction from ai-eligible label ────────────────
  const builderConviction = labels.includes('ai-eligible') ? 0.8 : 0.4;

  // ── Age → competitive drift ──────────────────────────────────
  const ageMs = Date.now() - new Date(input.createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const competitiveDrift = Math.min(1, Math.max(0, (ageDays - 30) / 180));

  // ── Security-rejected veto ───────────────────────────────────
  if (labels.includes('security-rejected')) {
    return {
      itemId: `#${input.issueNumber}`,
      title: input.title,
      description: input.body ?? '',
      labels,
      soulAlignment: 0, // veto
    };
  }

  return {
    itemId: `#${input.issueNumber}`,
    title: input.title,
    description: input.body ?? '',
    labels,
    soulAlignment,
    bugSeverity,
    customerRequestCount: input.reactionCount,
    demandSignal,
    builderConviction,
    complexity,
    competitiveDrift,
    teamConsensus,
    explicitPriority: labels.includes('high') ? 0.8 : labels.includes('low') ? 0.2 : undefined,
  };
}

// ── Suggestions ──────────────────────────────────────────────────────

function generateSuggestions(input: AdmissionInput, score: PriorityScore): string[] {
  const suggestions: string[] = [];
  const d = score.dimensions;

  if (score.confidence < 0.2) {
    suggestions.push(
      'Add more detail to improve scoring confidence (complexity, acceptance criteria, labels)',
    );
  }

  if (!input.body?.match(/###?\s*Complexity\s*\n/i)) {
    suggestions.push('Add a `### Complexity` section with a score from 1-10');
  }

  if (!input.body?.match(/###?\s*Acceptance Criteria/i)) {
    suggestions.push('Add an `### Acceptance Criteria` section with testable criteria');
  }

  if (input.body.length < 50) {
    suggestions.push('Provide a more detailed description of the problem or feature');
  }

  if (d.demandPressure < 0.3) {
    suggestions.push('Low demand signal — add reactions or comments to show interest');
  }

  if (d.soulAlignment < 0.5) {
    suggestions.push(
      'Add labels that indicate alignment with the project mission (e.g., governance, spec, security)',
    );
  }

  return suggestions;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Score a GitHub issue for pipeline admission using the Product Priority Algorithm.
 *
 * Returns whether the issue is admitted (score and confidence above thresholds)
 * along with the full score and, if rejected, suggestions for improvement.
 */
export function scoreIssueForAdmission(
  input: AdmissionInput,
  thresholds: AdmissionThresholds,
  priorityConfig?: PriorityConfig,
): IssueAdmissionResult {
  const priorityInput = mapIssueToPriorityInput(input);
  const score = computePriority(priorityInput, priorityConfig);

  const scorePasses = score.composite >= thresholds.minimumScore;
  const confidencePasses = score.confidence >= thresholds.minimumConfidence;
  const admitted = scorePasses && confidencePasses;

  if (admitted) {
    return {
      admitted: true,
      score,
      reason: `Score ${score.composite.toFixed(4)} meets threshold ${thresholds.minimumScore} with ${(score.confidence * 100).toFixed(0)}% confidence`,
    };
  }

  const reasons: string[] = [];
  if (!scorePasses) {
    reasons.push(`score ${score.composite.toFixed(4)} below minimum ${thresholds.minimumScore}`);
  }
  if (!confidencePasses) {
    reasons.push(
      `confidence ${(score.confidence * 100).toFixed(0)}% below minimum ${(thresholds.minimumConfidence * 100).toFixed(0)}%`,
    );
  }

  return {
    admitted: false,
    score,
    reason: `Not admitted: ${reasons.join('; ')}`,
    suggestions: generateSuggestions(input, score),
  };
}
