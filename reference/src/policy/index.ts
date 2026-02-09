export {
  enforce,
  evaluateGate,
  type EvaluationContext,
  type GateResult,
  type GateVerdict,
  type EnforcementResult,
} from './enforcement.js';

export {
  evaluatePromotion,
  evaluateDemotion,
  type AgentMetrics,
  type PromotionResult,
  type DemotionResult,
} from './autonomy.js';

export {
  scoreComplexity,
  routeByComplexity,
  evaluateComplexity,
  DEFAULT_COMPLEXITY_FACTORS,
  DEFAULT_THRESHOLDS,
  type ComplexityInput,
  type ComplexityFactor,
  type ComplexityResult,
} from './complexity.js';

export {
  checkPermission,
  checkConstraints,
  authorize,
  createAuthorizationHook,
  type AuthorizationContext,
  type AuthorizationResult,
  type AuthorizationHook,
} from './authorization.js';

export {
  createTokenAuthenticator,
  createAlwaysAuthenticator,
  type AuthIdentity,
  type AuthenticationResult,
  type Authenticator,
} from './authentication.js';

export {
  createLabelInjector,
  createMetadataEnricher,
  createReviewerAssigner,
  applyMutatingGates,
  type MutatingGate,
  type MutatingGateContext,
} from './mutating-gate.js';

export {
  createSimpleExpressionEvaluator,
  evaluateExpressionRule,
  type ExpressionEvaluator,
  type ExpressionRule,
  type ExpressionVerdict,
} from './expression.js';

export {
  evaluateLLMRule,
  createStubLLMEvaluator,
  type LLMEvaluationDimension,
  type LLMEvaluationResult,
  type LLMEvaluator,
  type LLMEvaluationRule,
  type LLMGateVerdict,
} from './llm-evaluator.js';

export {
  admitResource,
  type AdmissionRequest,
  type AdmissionPipeline,
  type AdmissionResult,
} from './admission.js';

export { parseDuration, DEFAULT_COOLDOWN_MS } from './autonomy.js';

export { createRegoEvaluator } from './rego-evaluator.js';

export { createCELEvaluator } from './cel-evaluator.js';

export { createABACAuthorizationHook, type ABACPolicy, type ABACContext } from './abac.js';
