/**
 * Issue admission scoring — maps GitHub issue fields to PPA dimensions
 * and determines whether an issue should enter the pipeline.
 *
 * Extracted from dogfood/scripts/ppa-score.ts for reuse across CLI
 * scripts and workflows.
 */

import type { PriorityInput, PriorityScore, PriorityConfig } from './priority.js';
import { computeAdmissionComposite } from './admission-composite.js';
import { computePillarBreakdown, type PillarBreakdown } from './pillar-breakdown.js';

// ── Types ────────────────────────────────────────────────────────────

/**
 * GitHub author_association values indicating trust level.
 * OWNER/MEMBER/COLLABORATOR = trusted (project team)
 * CONTRIBUTOR = semi-trusted (has had PRs merged)
 * NONE = untrusted (external)
 */
export type AuthorAssociation =
  | 'OWNER'
  | 'MEMBER'
  | 'COLLABORATOR'
  | 'CONTRIBUTOR'
  | 'FIRST_TIMER'
  | 'FIRST_TIME_CONTRIBUTOR'
  | 'NONE';

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
  /** GitHub author_association — determines trust-based signal boosting. */
  authorAssociation?: AuthorAssociation;
  /** GitHub login of the issue author (used by C5 principal match). */
  authorLogin?: string;
  /** GitHub logins of anyone who commented on the issue (C5 principal match). */
  commenterLogins?: string[];
  // ── RFC-0008 PPA Triad enrichment (all optional, backward compatible) ──
  /** C2 Eρ₄ inputs — populated by enrichAdmissionInput() (AISDLC-43). */
  designSystemContext?: DesignSystemContext;
  /** C4 inputs — current earned autonomy vs. required level (AISDLC-45). */
  autonomyContext?: AutonomyContext;
  /** C3 inputs — defect/churn/rejection signals per code area (AISDLC-44). */
  codeAreaQuality?: CodeAreaQuality;
  /** C5 inputs — HC_design signal from design-authority principals (AISDLC-46). */
  designAuthoritySignal?: DesignAuthoritySignal;
}

export interface DesignSystemContext {
  /** Catalog coverage percent (0–100) from DSB.status.catalogHealth. */
  catalogCoverage?: number;
  /** Token compliance percent (0–100) from DSB.status.tokenCompliance. */
  tokenCompliance?: number;
  /** True when DSB is young or catalog coverage is below the bootstrap floor. */
  inBootstrapPhase?: boolean;
  /** Baseline coverage from visual_regression_results before DSB adoption. */
  baselineCoverage?: number;
  /** Component/token gaps preventing the issue from being built catalog-first. */
  catalogGaps?: string[];
}

export interface AutonomyContext {
  /** The AutonomyPolicy-issued earned level for the current agent (0–3). */
  currentEarnedLevel: number;
  /** Level required by the issue's complexity band (≤3→1, ≤6→2, else→3). */
  requiredLevel: number;
}

export interface DesignQualityMetrics {
  /** Fraction of design CI checks passing in the window (0–1). */
  designCIPassRate?: number;
  /** Fraction of PRs in the area rejected on design grounds (0–1). */
  designReviewRejectionRate?: number;
  /** Fraction of usability-sim tasks completed successfully (0–1). */
  usabilitySimPassRate?: number;
}

export interface CodeAreaQuality {
  defectDensity?: number;
  churnRate?: number;
  prRejectionRate?: number;
  /** True when the code area produces frontend artifacts gated by the DSB. */
  hasFrontendComponents: boolean;
  /** Present only when `hasFrontendComponents === true`. */
  designQuality?: DesignQualityMetrics;
}

export type DesignAuthoritySignalType =
  | 'advances-design-coherence'
  | 'fills-catalog-gap'
  | 'fragments-component-catalog'
  | 'misaligned-with-brand'
  | 'unspecified';

export interface DesignAuthoritySignal {
  /** True when the issue author/commenter is a DSB designAuthority principal. */
  isDesignAuthority: boolean;
  /** The signal type parsed from labels or structured comments. */
  signalType?: DesignAuthoritySignalType;
  /** The issue's code area compliance score in [0, 1] (used to modulate weight). */
  areaComplianceScore?: number;
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
  /**
   * RFC-0008 §A.6 — pillar attribution + tension flags. Required on
   * every admission result so reviewers can act on pillar mismatches.
   */
  pillarBreakdown: PillarBreakdown;
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
  const assoc = input.authorAssociation ?? 'NONE';

  // ── Trust-based signal boosting ────────────────────────────────
  // Trusted sources (project team) get baseline conviction and demand.
  // Untrusted sources need external validation (reactions, comments).
  const isTrusted = assoc === 'OWNER' || assoc === 'MEMBER' || assoc === 'COLLABORATOR';
  const isContributor = assoc === 'CONTRIBUTOR';

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
  // Trusted authors get a soul alignment floor — they know the project mission
  if (isTrusted && soulAlignment < 0.6) soulAlignment = 0.6;

  // ── Reactions → demand / consensus ───────────────────────────
  const reactionConsensus = Math.min(1, input.reactionCount / 5);
  // Trusted sources carry implicit team consensus
  const teamConsensus = isTrusted ? Math.max(0.5, reactionConsensus) : reactionConsensus;

  // ── Comment count → demand signal ────────────────────────────
  const commentDemand = Math.min(1, input.commentCount / 5);
  // Trusted sources filing an issue IS demand — they wouldn't file it otherwise
  const demandSignal = isTrusted
    ? Math.max(0.4, commentDemand)
    : isContributor
      ? Math.max(0.2, commentDemand)
      : commentDemand;

  // ── Builder conviction ─────────────────────────────────────────
  // Trusted: high conviction (they're the builders)
  // Contributor: moderate (proven track record)
  // ai-eligible label: explicit signal
  // Default: low (needs validation)
  const builderConviction = labels.includes('ai-eligible')
    ? 0.8
    : isTrusted
      ? 0.8
      : isContributor
        ? 0.6
        : 0.4;

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

  const assoc = input.authorAssociation ?? 'NONE';
  const isTrusted = assoc === 'OWNER' || assoc === 'MEMBER' || assoc === 'COLLABORATOR';
  if (d.demandPressure < 0.3 && !isTrusted) {
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
 * Score a GitHub issue for pipeline admission using the RFC-0008 §A.6
 * admission-subset composite.
 *
 *   P_admission = SA × D-pi_adjusted × ER × (1 + HC)
 *
 * M-phi, E-tau, C-kappa are deferred to runtime scoring — they apply
 * when an admitted issue is picked up for execution, not at the gate.
 *
 * Returns whether the issue is admitted (score and confidence above
 * thresholds) along with the full score and, if rejected, suggestions
 * for improvement.
 */
export function scoreIssueForAdmission(
  input: AdmissionInput,
  thresholds: AdmissionThresholds,
  priorityConfig?: PriorityConfig,
): IssueAdmissionResult {
  const composite = computeAdmissionComposite(input, priorityConfig);
  const { score } = composite;
  const pillarBreakdown = computePillarBreakdown(composite);

  const scorePasses = score.composite >= thresholds.minimumScore;
  const confidencePasses = score.confidence >= thresholds.minimumConfidence;
  const admitted = scorePasses && confidencePasses;

  if (admitted) {
    return {
      admitted: true,
      score,
      reason: `Score ${score.composite.toFixed(4)} meets threshold ${thresholds.minimumScore} with ${(score.confidence * 100).toFixed(0)}% confidence`,
      pillarBreakdown,
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
    pillarBreakdown,
  };
}
