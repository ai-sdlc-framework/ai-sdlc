/**
 * Quality gate enforcement engine.
 * Implements the 3-tier enforcement model from spec/policy.md.
 */

import type {
  Gate,
  EnforcementLevel,
  QualityGate,
  ToolRule,
  ReviewerRule,
  DocumentationRule,
  ProvenanceRule,
  CostRule,
  DesignTokenComplianceRule,
  VisualRegressionRule,
  StoryCompletenessRule,
  DesignReviewGateRule,
  DesignReviewDecision,
} from '../core/types.js';
import { compareMetric, exceedsSeverity } from '../core/compare.js';

export interface EvaluationContext {
  authorType: 'ai-agent' | 'human' | 'bot' | 'service-account';
  repository: string;
  metrics: Record<string, number>;
  overrideRole?: string;
  overrideJustification?: string;
  toolResults?: Record<
    string,
    { findings: { severity: 'low' | 'medium' | 'high' | 'critical' }[] }
  >;
  reviewerCount?: number;
  changedFiles?: string[];
  docFiles?: string[];
  provenance?: { attribution?: boolean; humanReviewed?: boolean };
  /** Design review context for designReview gate rules (RFC-0006 §8.5). */
  designReview?: {
    decision?: DesignReviewDecision;
    reviewer?: string;
    pendingTimeout?: boolean;
  };
  /** Design token compliance violations by category (RFC-0006 §8.1). */
  designTokenViolations?: Record<string, number>;
  /** Story metadata for completeness checks (RFC-0006 §8.3). */
  storyMeta?: {
    hasDefaultStory?: boolean;
    hasStateStories?: boolean;
    hasA11yStory?: boolean;
    storyCount?: number;
  };
}

export type GateVerdict = 'pass' | 'fail' | 'override';

export interface GateResult {
  gate: string;
  enforcement: EnforcementLevel;
  verdict: GateVerdict;
  message?: string;
}

export interface EnforcementResult {
  allowed: boolean;
  results: GateResult[];
}

interface RuleResult {
  passed: boolean;
  message?: string;
}

/**
 * Evaluate a single rule against the provided context.
 */
function evaluateRule(rule: Gate['rule'], ctx: EvaluationContext): RuleResult {
  // Metric-based rule
  if ('metric' in rule && 'operator' in rule && 'threshold' in rule) {
    const actual = ctx.metrics[rule.metric];
    if (actual === undefined) {
      return { passed: false, message: `Metric "${rule.metric}" not available` };
    }
    return {
      passed: compareMetric(actual, rule.operator as string, rule.threshold as number),
    };
  }

  // Tool-based rule
  if ('tool' in rule) {
    const toolRule = rule as ToolRule;
    const results = ctx.toolResults?.[toolRule.tool];
    if (!results) {
      return { passed: false, message: `Tool "${toolRule.tool}" results not available` };
    }
    if (toolRule.maxSeverity) {
      const violations = results.findings.filter((f) =>
        exceedsSeverity(f.severity, toolRule.maxSeverity!),
      );
      if (violations.length > 0) {
        return {
          passed: false,
          message: `${violations.length} finding(s) exceed max severity "${toolRule.maxSeverity}"`,
        };
      }
    }
    return { passed: true };
  }

  // Reviewer-based rule
  if ('minimumReviewers' in rule) {
    const reviewerRule = rule as ReviewerRule;
    let required = reviewerRule.minimumReviewers;
    if (reviewerRule.aiAuthorRequiresExtraReviewer && ctx.authorType === 'ai-agent') {
      required += 1;
    }
    const actual = ctx.reviewerCount ?? 0;
    if (actual >= required) {
      return { passed: true };
    }
    return {
      passed: false,
      message: `Requires ${required} reviewer(s), got ${actual}`,
    };
  }

  // Documentation-based rule
  if ('changedFilesRequireDocUpdate' in rule) {
    const docRule = rule as DocumentationRule;
    if (!docRule.changedFilesRequireDocUpdate) {
      return { passed: true };
    }
    const hasCodeChanges = (ctx.changedFiles ?? []).length > 0;
    const hasDocChanges = (ctx.docFiles ?? []).length > 0;
    if (hasCodeChanges && !hasDocChanges) {
      return { passed: false, message: 'Code changes require documentation updates' };
    }
    return { passed: true };
  }

  // Cost-based rule
  if ('cost' in rule) {
    const costRule = rule as CostRule;
    const actual = ctx.metrics[costRule.cost.metric];
    if (actual === undefined) {
      return { passed: false, message: `Cost metric "${costRule.cost.metric}" not available` };
    }
    return {
      passed: compareMetric(actual, costRule.cost.operator, costRule.cost.threshold),
    };
  }

  // Provenance-based rule
  if ('requireAttribution' in rule) {
    const provRule = rule as ProvenanceRule;
    const prov = ctx.provenance ?? {};
    if (provRule.requireAttribution && !prov.attribution) {
      return { passed: false, message: 'Attribution is required' };
    }
    if (provRule.requireHumanReview && !prov.humanReviewed) {
      return { passed: false, message: 'Human review is required' };
    }
    return { passed: true };
  }

  // Design token compliance rule (RFC-0006 §8.1)
  if ('designTokenCompliance' in rule) {
    const dtcRule = rule as DesignTokenComplianceRule;

    // Coverage metric mode
    if (dtcRule.coverageMetric) {
      const coverage = ctx.metrics['token-coverage'];
      if (coverage === undefined) {
        return { passed: false, message: 'Metric "token-coverage" not available' };
      }
      return {
        passed: compareMetric(
          coverage,
          dtcRule.coverageMetric.operator,
          dtcRule.coverageMetric.threshold,
        ),
        message: !compareMetric(
          coverage,
          dtcRule.coverageMetric.operator,
          dtcRule.coverageMetric.threshold,
        )
          ? `Token coverage ${coverage} does not meet ${dtcRule.coverageMetric.operator} ${dtcRule.coverageMetric.threshold}`
          : undefined,
      };
    }

    // Violation count mode
    const category = dtcRule.category ?? 'all';
    const violations =
      ctx.designTokenViolations?.[category] ?? ctx.metrics[`${category}-violations`] ?? 0;
    const max = dtcRule.maxViolations ?? 0;
    if (violations > max) {
      return {
        passed: false,
        message: `${violations} ${category} token violation(s) exceed max ${max}`,
      };
    }
    return { passed: true };
  }

  // Visual regression rule (RFC-0006 §8.2)
  if ('visualRegression' in rule) {
    const vrRule = rule as VisualRegressionRule;
    const diffPct = ctx.metrics['visual-diff-percentage'];

    if (vrRule.config.requireBaseline && ctx.metrics['baseline-exists'] === 0) {
      return { passed: false, message: 'Visual baseline does not exist' };
    }

    if (diffPct === undefined) {
      return { passed: false, message: 'Metric "visual-diff-percentage" not available' };
    }

    if (diffPct > vrRule.config.diffThreshold) {
      return {
        passed: false,
        message: `Visual diff ${(diffPct * 100).toFixed(1)}% exceeds threshold ${(vrRule.config.diffThreshold * 100).toFixed(1)}%`,
      };
    }
    return { passed: true };
  }

  // Story completeness rule (RFC-0006 §8.3)
  if ('storyCompleteness' in rule) {
    const scRule = rule as StoryCompletenessRule;
    const meta = ctx.storyMeta;
    if (!meta) {
      return { passed: false, message: 'Story metadata not available' };
    }

    if (scRule.config.requireDefaultStory && !meta.hasDefaultStory) {
      return { passed: false, message: 'Default story is required but missing' };
    }
    if (scRule.config.requireStateStories && !meta.hasStateStories) {
      return { passed: false, message: 'Interactive state stories are required but missing' };
    }
    if (scRule.config.requireA11yStory && !meta.hasA11yStory) {
      return { passed: false, message: 'Accessibility story is required but missing' };
    }
    if (scRule.config.minStories && (meta.storyCount ?? 0) < scRule.config.minStories) {
      return {
        passed: false,
        message: `Component has ${meta.storyCount ?? 0} stories, minimum ${scRule.config.minStories} required`,
      };
    }
    return { passed: true };
  }

  // Design review rule (RFC-0006 §8.5)
  if ('designReview' in rule) {
    const drRule = rule as DesignReviewGateRule;
    const review = ctx.designReview;

    if (!review) {
      return { passed: false, message: 'Design review not yet submitted' };
    }

    if (review.pendingTimeout) {
      if (drRule.onTimeout === 'fail') {
        return { passed: false, message: 'Design review timed out' };
      }
      // 'pause' means the pipeline should hold — treat as not-yet-passed
      return { passed: false, message: 'Design review pending (timed out, paused)' };
    }

    if (review.decision === 'approved' || review.decision === 'approved-with-comments') {
      return { passed: true };
    }

    return {
      passed: false,
      message: `Design review ${review.decision ?? 'pending'} by ${review.reviewer ?? 'unknown'}`,
    };
  }

  return { passed: false, message: 'Unknown rule type' };
}

/**
 * Evaluate a single gate against the provided context.
 */
export function evaluateGate(gate: Gate, ctx: EvaluationContext): GateResult {
  const result = evaluateRule(gate.rule, ctx);

  if (result.passed) {
    return { gate: gate.name, enforcement: gate.enforcement, verdict: 'pass' };
  }

  // Check for soft-mandatory override (applies to all rule types)
  if (gate.enforcement === 'soft-mandatory' && gate.override && ctx.overrideRole) {
    if (ctx.overrideRole === gate.override.requiredRole) {
      if (!gate.override.requiresJustification || ctx.overrideJustification) {
        return {
          gate: gate.name,
          enforcement: gate.enforcement,
          verdict: 'override',
          message: `Overridden by ${ctx.overrideRole}`,
        };
      }
    }
  }

  return {
    gate: gate.name,
    enforcement: gate.enforcement,
    verdict: 'fail',
    message: result.message,
  };
}

/**
 * Evaluate all gates in a QualityGate resource and determine whether
 * the action is allowed.
 *
 * Enforcement semantics:
 * - advisory: logged but never blocks
 * - soft-mandatory: blocks unless overridden by authorized role
 * - hard-mandatory: always blocks on failure, no override
 */
export function enforce(qualityGate: QualityGate, ctx: EvaluationContext): EnforcementResult {
  const results = qualityGate.spec.gates.map((gate) => evaluateGate(gate, ctx));

  const allowed = results.every((r) => {
    if (r.verdict === 'pass' || r.verdict === 'override') return true;
    if (r.enforcement === 'advisory') return true;
    return false;
  });

  return { allowed, results };
}
