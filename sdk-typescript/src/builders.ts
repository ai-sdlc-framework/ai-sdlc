/**
 * Resource builders and distribution builder.
 * Subpath: @ai-sdlc/sdk/builders
 */
export {
  PipelineBuilder,
  AgentRoleBuilder,
  QualityGateBuilder,
  AutonomyPolicyBuilder,
  AdapterBindingBuilder,

  // Distribution builder
  parseBuilderManifest,
  validateBuilderManifest,
  buildDistribution,
  type BuilderManifest,
  type ManifestAdapter,
  type ManifestOutput,
  type ResolvedAdapter,
  type DistributionBuildResult,
  type BuildDistributionOptions,
} from '@ai-sdlc/reference';
