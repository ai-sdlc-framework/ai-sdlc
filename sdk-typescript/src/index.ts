/**
 * @ai-sdlc/sdk — TypeScript SDK for building AI-SDLC implementations.
 *
 * Re-exports core types and validation from the reference implementation,
 * and will provide higher-level helpers for common integration patterns.
 */

export {
  // Core types
  type Pipeline,
  type AgentRole,
  type QualityGate,
  type AutonomyPolicy,
  type AdapterBinding,
  type AnyResource,
  type ResourceKind,
  type Metadata,
  type Condition,
  API_VERSION,

  // Validation
  validate,
  validateResource,
  type ValidationResult,
  type ValidationError,
} from '@ai-sdlc/reference';
