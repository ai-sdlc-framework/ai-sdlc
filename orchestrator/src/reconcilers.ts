/**
 * Specialized reconciler integration — wraps pipeline/gate/autonomy reconcilers
 * and diff utilities for smarter reconciliation in watch mode.
 */

import {
  createPipelineReconciler as _createPipelineReconciler,
  createGateReconciler as _createGateReconciler,
  createAutonomyReconciler as _createAutonomyReconciler,
  resourceFingerprint,
  hasSpecChanged,
  calculateBackoff,
  reconcileOnce,
  createResourceCache,
  DEFAULT_RECONCILER_CONFIG,
  type ReconcilerFn,
  type ReconcilerConfig,
  type ReconcileResult,
  type ResourceCache,
  type AnyResource,
  type Pipeline,
  type QualityGate,
  type AutonomyPolicy,
  type PipelineReconcilerDeps,
  type GateReconcilerDeps,
  type AutonomyReconcilerDeps,
} from '@ai-sdlc/reference';

/**
 * Create a pipeline reconciler that watches for pipeline resource changes.
 */
export function createPipelineReconciler(
  deps: PipelineReconcilerDeps,
): ReconcilerFn<Pipeline> {
  return _createPipelineReconciler(deps);
}

/**
 * Create a gate reconciler that re-evaluates quality gates when they change.
 */
export function createGateReconciler(deps: GateReconcilerDeps): ReconcilerFn<QualityGate> {
  return _createGateReconciler(deps);
}

/**
 * Create an autonomy reconciler that checks for promotion/demotion.
 */
export function createAutonomyReconciler(
  deps: AutonomyReconcilerDeps,
): ReconcilerFn<AutonomyPolicy> {
  return _createAutonomyReconciler(deps);
}

/**
 * Check if a resource's spec has changed since a previous version.
 */
export function hasResourceChanged(previous: AnyResource, current: AnyResource): boolean {
  return hasSpecChanged(previous, current);
}

/**
 * Generate a fingerprint for a resource (used for change detection).
 */
export function fingerprintResource(resource: AnyResource): string {
  return resourceFingerprint(resource);
}

export {
  _createPipelineReconciler as createRefPipelineReconciler,
  _createGateReconciler as createRefGateReconciler,
  _createAutonomyReconciler as createRefAutonomyReconciler,
  resourceFingerprint,
  hasSpecChanged,
  calculateBackoff,
  reconcileOnce,
  createResourceCache,
  DEFAULT_RECONCILER_CONFIG,
};

export type {
  ReconcilerFn,
  ReconcilerConfig,
  ReconcileResult,
  ResourceCache,
  PipelineReconcilerDeps,
  GateReconcilerDeps,
  AutonomyReconcilerDeps,
};
