/**
 * Deployment targets barrel export.
 */

export type {
  DeploymentTargetConfig,
  HealthCheckConfig,
  DeploymentState,
  DeploymentResult,
  DeploymentTarget,
  ExecFn,
  FetchFn,
} from './types.js';

export { createKubernetesTarget } from './kubernetes-target.js';
export type { KubernetesConfig } from './kubernetes-target.js';

export { createVercelTarget } from './vercel-target.js';
export type { VercelConfig } from './vercel-target.js';

export { createFlyioTarget } from './flyio-target.js';
export type { FlyioConfig } from './flyio-target.js';

// Rollout types
export type {
  CanaryStep,
  CanaryConfig,
  BlueGreenConfig,
  RollingConfig,
  RolloutStrategy,
  RolloutPhase,
  RolloutStatus,
  RolloutMetrics,
  MetricsSource,
  RolloutControllerConfig,
} from './rollout-types.js';

// Metrics collection
export { createHttpMetricsCollector, createStubMetricsCollector } from './metrics-collector.js';
export type { HttpMetricsConfig } from './metrics-collector.js';

// Rollout controller
export { RolloutController } from './rollout-controller.js';
