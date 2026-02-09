/**
 * Specialized reconciler integration — wraps pipeline/gate/autonomy reconcilers
 * and diff utilities for smarter reconciliation in watch mode.
 */

import {
  createPipelineReconciler,
  createGateReconciler,
  createAutonomyReconciler,
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
export function createDogfoodPipelineReconciler(
  deps: PipelineReconcilerDeps,
): ReconcilerFn<Pipeline> {
  return createPipelineReconciler(deps);
}

/**
 * Create a gate reconciler that re-evaluates quality gates when they change.
 */
export function createDogfoodGateReconciler(deps: GateReconcilerDeps): ReconcilerFn<QualityGate> {
  return createGateReconciler(deps);
}

/**
 * Create an autonomy reconciler that checks for promotion/demotion.
 */
export function createDogfoodAutonomyReconciler(
  deps: AutonomyReconcilerDeps,
): ReconcilerFn<AutonomyPolicy> {
  return createAutonomyReconciler(deps);
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
  createPipelineReconciler,
  createGateReconciler,
  createAutonomyReconciler,
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
