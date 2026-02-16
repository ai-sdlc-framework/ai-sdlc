// Re-export everything from the orchestrator package
export * from '@ai-sdlc/orchestrator';

// Backward-compatible reconciler aliases
export {
  createPipelineReconciler as createDogfoodPipelineReconciler,
  createGateReconciler as createDogfoodGateReconciler,
  createAutonomyReconciler as createDogfoodAutonomyReconciler,
} from '@ai-sdlc/orchestrator';

// Resource builders (dogfood-specific)
export {
  buildDogfoodPipeline,
  buildDogfoodAgentRole,
  buildDogfoodQualityGate,
  buildDogfoodAutonomyPolicy,
  buildDogfoodAdapterBinding,
  PipelineBuilder,
  AgentRoleBuilder,
  QualityGateBuilder,
  AutonomyPolicyBuilder,
  AdapterBindingBuilder,
  parseBuilderManifest,
  validateBuilderManifest,
  parsePipelineManifest,
  buildPipelineDistribution,
  API_VERSION,
  type BuilderManifest,
  type BuildDistributionOptions,
  type DistributionBuildResult,
} from './builders.js';
