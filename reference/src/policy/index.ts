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
