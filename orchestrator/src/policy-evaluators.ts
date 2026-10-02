/**
 * Policy evaluator integration — wraps advanced policy evaluators
 * (Rego, CEL, ABAC, expression, LLM) for pipeline gate evaluation.
 */

import {
  createRegoEvaluator,
  createCELEvaluator,
  createABACAuthorizationHook,
  createSimpleExpressionEvaluator,
  createStubLLMEvaluator,
  evaluateGate,
  scoreComplexity,
  evaluateComplexity,
  type ExpressionEvaluator,
  type LLMEvaluator,
  type ABACPolicy,
  type AuthorizationHook,
  type ComplexityInput,
  type ComplexityResult,
  type GateResult,
  type Gate,
  type EvaluationContext,
  type EvaluateJudgmentContext,
} from '@ai-sdlc/reference';
import { applyComplexityFactorJudgment } from './judgment/complexity-factors.js';

/**
 * Create a Rego-based policy evaluator for gate rules.
 */
export function createPipelineRegoEvaluator() {
  return createRegoEvaluator();
}

/**
 * Create a CEL-based policy evaluator for gate rules.
 */
export function createPipelineCELEvaluator() {
  return createCELEvaluator();
}

/**
 * Create an ABAC authorization hook from a set of policies.
 */
export function createPipelineABACHook(policies: ABACPolicy[]): AuthorizationHook {
  const evaluator = createSimpleExpressionEvaluator();
  return createABACAuthorizationHook(evaluator, policies);
}

/**
 * Create a simple expression evaluator for ExpressionRule gates.
 */
export function createPipelineExpressionEvaluator(): ExpressionEvaluator {
  return createSimpleExpressionEvaluator();
}

/**
 * Create a stub LLM evaluator for testing LLM gate rules.
 */
export function createPipelineLLMEvaluator(): LLMEvaluator {
  return createStubLLMEvaluator([]);
}

/**
 * Evaluate a single gate with a given context.
 */
export function evaluatePipelineGate(gate: Gate, ctx: EvaluationContext): GateResult {
  return evaluateGate(gate, ctx);
}

/**
 * Score issue complexity using the reference scoring function.
 */
export function scorePipelineComplexity(input: ComplexityInput): number {
  return scoreComplexity(input);
}

/**
 * Full complexity evaluation with routing recommendation.
 */
export function evaluatePipelineComplexityRouting(input: ComplexityInput): ComplexityResult {
  return evaluateComplexity(input);
}

/**
 * Judgment-aware variant of {@link scorePipelineComplexity}. Tighten-only: the boolean
 * factors may be raised from the work item text, never lowered. Without a context (or
 * when the layer is disabled, shadow, abstains or errors) the result equals the sync form.
 */
export async function scorePipelineComplexityWithJudgment(
  input: ComplexityInput,
  workItemText: string,
  judgment?: EvaluateJudgmentContext,
): Promise<number> {
  if (!judgment) return scoreComplexity(input);
  return scoreComplexity(await applyComplexityFactorJudgment(input, workItemText, judgment));
}

/** Judgment-aware variant of {@link evaluatePipelineComplexityRouting}; same tighten-only rules. */
export async function evaluatePipelineComplexityRoutingWithJudgment(
  input: ComplexityInput,
  workItemText: string,
  judgment?: EvaluateJudgmentContext,
): Promise<ComplexityResult> {
  if (!judgment) return evaluateComplexity(input);
  return evaluateComplexity(await applyComplexityFactorJudgment(input, workItemText, judgment));
}

// Direct re-exports (passthrough)
export {
  createRegoEvaluator,
  createCELEvaluator,
  createABACAuthorizationHook,
  createSimpleExpressionEvaluator,
  createStubLLMEvaluator,
  evaluateGate,
  scoreComplexity,
  evaluateComplexity,
  checkPermission,
  checkConstraints,
  createAuthorizationHook,
  createTokenAuthenticator,
  parseDuration,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_COMPLEXITY_FACTORS,
  DEFAULT_THRESHOLDS,
} from '@ai-sdlc/reference';

export type {
  ExpressionEvaluator,
  LLMEvaluator,
  ABACPolicy,
  ABACContext,
  ComplexityInput,
  ComplexityResult,
  GateResult,
} from '@ai-sdlc/reference';
