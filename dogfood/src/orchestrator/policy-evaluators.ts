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
} from '@ai-sdlc/reference';

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
