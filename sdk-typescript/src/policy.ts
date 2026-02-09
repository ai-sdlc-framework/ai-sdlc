/**
 * Policy enforcement, autonomy, complexity, authorization, authentication,
 * mutating gates, expression evaluator, LLM evaluation, and admission.
 * Subpath: @ai-sdlc/sdk/policy
 */
export {
  // Enforcement
  enforce,
  evaluateGate,
  type EvaluationContext,
  type GateResult,
  type GateVerdict,
  type EnforcementResult,

  // Autonomy
  evaluatePromotion,
  evaluateDemotion,
  parseDuration,
  DEFAULT_COOLDOWN_MS,
  type AgentMetrics,
  type PromotionResult,
  type DemotionResult,

  // Complexity
  scoreComplexity,
  routeByComplexity,
  evaluateComplexity,
  DEFAULT_COMPLEXITY_FACTORS,
  DEFAULT_THRESHOLDS,
  type ComplexityInput,
  type ComplexityFactor,
  type ComplexityResult,

  // Authorization
  checkPermission,
  checkConstraints,
  authorize,
  createAuthorizationHook,
  type AuthorizationContext,
  type AuthorizationResult,
  type AuthorizationHook,

  // Authentication
  createTokenAuthenticator,
  createAlwaysAuthenticator,
  type AuthIdentity,
  type AuthenticationResult,
  type Authenticator,

  // Mutating gates
  createLabelInjector,
  createMetadataEnricher,
  createReviewerAssigner,
  applyMutatingGates,
  type MutatingGate,
  type MutatingGateContext,

  // Expression evaluator
  createSimpleExpressionEvaluator,
  evaluateExpressionRule,
  type ExpressionEvaluator,
  type ExpressionRule,
  type ExpressionVerdict,

  // LLM evaluation
  evaluateLLMRule,
  createStubLLMEvaluator,
  type LLMEvaluationDimension,
  type LLMEvaluationResult,
  type LLMEvaluator,
  type LLMEvaluationRule,
  type LLMGateVerdict,

  // Admission
  admitResource,
  type AdmissionRequest,
  type AdmissionPipeline,
  type AdmissionResult,

  // Policy evaluators
  createRegoEvaluator,
  createCELEvaluator,

  // ABAC
  createABACAuthorizationHook,
  type ABACPolicy,
  type ABACContext,
} from '@ai-sdlc/reference';
