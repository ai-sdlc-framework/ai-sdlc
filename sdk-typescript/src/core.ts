/**
 * Core types, validation, comparison, and provenance.
 * Subpath: @ai-sdlc/sdk/core
 */
export {
  // Resource types
  type Pipeline,
  type PipelineSpec,
  type AgentRole,
  type AgentRoleSpec,
  type QualityGate,
  type QualityGateSpec,
  type AutonomyPolicy,
  type AdapterBinding,
  type AdapterBindingSpec,
  type AnyResource,
  type ResourceKind,
  type Metadata,
  type Condition,
  type Stage,
  type Trigger,
  type Provider,
  type Routing,
  type AgentConstraints,
  type Handoff,
  type Skill,
  type AgentCard,
  type Gate,
  type GateScope,
  type Evaluation,
  type AutonomyLevel,
  type PromotionCriteria,
  type DemotionTrigger,
  type AdapterInterface,
  type HealthCheck,
  type GateRule,
  API_VERSION,

  // Validation
  validate,
  validateResource,
  type ValidationResult,
  type ValidationError,

  // Comparison
  compareMetric,
  exceedsSeverity,

  // Provenance
  createProvenance,
  provenanceToAnnotations,
  provenanceFromAnnotations,
  validateProvenance,
  PROVENANCE_ANNOTATION_PREFIX,
  type ProvenanceRecord,
  type ReviewDecision,
} from '@ai-sdlc/reference';
