/**
 * Quality gate enforcement engine.
 * Implements the 3-tier enforcement model from spec/policy.md.
 */

import type { Gate, EnforcementLevel, QualityGate } from '../core/types.js';

export interface EvaluationContext {
  authorType: 'ai-agent' | 'human' | 'bot' | 'service-account';
  repository: string;
  metrics: Record<string, number>;
  overrideRole?: string;
  overrideJustification?: string;
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

/**
 * Evaluate a single gate against the provided context.
 */
export function evaluateGate(gate: Gate, ctx: EvaluationContext): GateResult {
  const rule = gate.rule;

  // Metric-based rule
  if ('metric' in rule && 'operator' in rule && 'threshold' in rule) {
    const actual = ctx.metrics[rule.metric];
    if (actual === undefined) {
      return { gate: gate.name, enforcement: gate.enforcement, verdict: 'fail', message: `Metric "${rule.metric}" not available` };
    }
    const passed = compareMetric(actual, rule.operator as string, rule.threshold as number);
    if (passed) {
      return { gate: gate.name, enforcement: gate.enforcement, verdict: 'pass' };
    }
  }

  // Tool-based rule
  if ('tool' in rule) {
    // Tool-based gates require external tool invocation; stub as fail
    return { gate: gate.name, enforcement: gate.enforcement, verdict: 'fail', message: 'Tool-based evaluation requires adapter' };
  }

  // Reviewer-based, documentation-based, provenance-based — stub
  if ('minimumReviewers' in rule || 'changedFilesRequireDocUpdate' in rule || 'requireAttribution' in rule) {
    return { gate: gate.name, enforcement: gate.enforcement, verdict: 'fail', message: 'Rule type requires external context' };
  }

  // Check for soft-mandatory override
  if (gate.enforcement === 'soft-mandatory' && gate.override && ctx.overrideRole) {
    if (ctx.overrideRole === gate.override.requiredRole) {
      if (!gate.override.requiresJustification || ctx.overrideJustification) {
        return { gate: gate.name, enforcement: gate.enforcement, verdict: 'override', message: `Overridden by ${ctx.overrideRole}` };
      }
    }
  }

  return { gate: gate.name, enforcement: gate.enforcement, verdict: 'fail' };
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

function compareMetric(actual: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case '>=': return actual >= threshold;
    case '<=': return actual <= threshold;
    case '==': return actual === threshold;
    case '!=': return actual !== threshold;
    case '>':  return actual > threshold;
    case '<':  return actual < threshold;
    default:   return false;
  }
}
