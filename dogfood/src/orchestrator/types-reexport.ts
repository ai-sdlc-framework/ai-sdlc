/**
 * Comprehensive type re-exports from @ai-sdlc/reference.
 * Ensures all reference types are accessible through the dogfood package
 * for downstream consumers without direct reference dependency.
 */

// ── Core resource types ──────────────────────────────────────────────

export type {
  ApiVersion,
  Metadata,
  Condition,
  SecretRef,
  MetricCondition,
  Duration,
  Resource,
  TriggerFilter,
  Trigger,
  Provider,
  RoutingStrategy,
  ComplexityThreshold,
  Routing,
  Stage,
  PipelineSpec,
  PipelinePhase,
  PipelineStatus,
  Pipeline,
  AgentConstraints,
  HandoffContractRef,
  Handoff,
  SkillExample,
  Skill,
  AgentCard,
  AgentRoleSpec,
  AgentRoleStatus,
  AgentRole,
  GateScope,
  MetricRule,
  ToolRule,
  ReviewerRule,
  DocumentationRule,
  ProvenanceRule,
  ExpressionRule,
  GateRule,
  EnforcementLevel,
  Override,
  RetryPolicy,
  Evaluation,
  Gate,
  QualityGateSpec,
  QualityGateStatus,
  QualityGate,
  Permissions,
  ApprovalRequirement,
  Guardrails,
  MonitoringLevel,
  AutonomyLevel,
  PromotionCriteria,
  DemotionTrigger,
  AgentAutonomyStatus,
  AutonomyPolicySpec,
  AutonomyPolicyStatus,
  AutonomyPolicy,
  AdapterInterface,
  HealthCheck,
  AdapterBindingSpec,
  AdapterBindingStatus,
  AdapterBinding,
  AnyResource,
  ResourceKind,
  // Validation (note: ValidationResult is not re-exported to avoid conflict with dogfood's own)
  ValidationError,
} from '@ai-sdlc/reference';

// ── Policy types ─────────────────────────────────────────────────────

export type {
  GateVerdict,
  DemotionResult,
  ComplexityFactor,
  AuthorizationContext,
  AuthorizationResult,
  AuthIdentity,
  AuthenticationResult,
  Authenticator,
  MutatingGateContext,
  ExpressionEvaluator,
  ExpressionVerdict,
  LLMEvaluationDimension,
  LLMEvaluationResult,
  LLMGateVerdict,
} from '@ai-sdlc/reference';

// ── Agent types ──────────────────────────────────────────────────────

export type {
  AgentExecutionState,
  HandoffValidationError,
  SchemaResolver,
  SchemaValidationError,
  MemoryTier,
  MemoryEntry,
  WorkingMemory,
  ShortTermMemory,
  LongTermMemory,
  SharedMemory,
  EpisodicMemory,
} from '@ai-sdlc/reference';
