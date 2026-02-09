/**
 * Reconciliation loop, domain reconcilers, and diff utilities.
 * Subpath: @ai-sdlc/sdk/reconciler
 */
export {
  ReconcilerLoop,
  reconcileOnce,
  calculateBackoff,
  type ReconcileResult,
  type ReconcilerFn,
  type ReconcilerConfig,
  DEFAULT_RECONCILER_CONFIG,

  // Domain reconcilers
  createPipelineReconciler,
  type PipelineReconcilerDeps,
  createGateReconciler,
  type GateReconcilerDeps,
  createAutonomyReconciler,
  type AutonomyReconcilerDeps,

  // Diff
  resourceFingerprint,
  hasSpecChanged,
  createResourceCache,
  type ResourceCache,
} from '@ai-sdlc/reference';
