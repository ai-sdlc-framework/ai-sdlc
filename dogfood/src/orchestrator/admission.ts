/**
 * Admission pipeline module — composes authentication, authorization,
 * mutating gates, and enforcement into a single admission flow.
 */

import {
  admitResource,
  createAlwaysAuthenticator,
  createLabelInjector,
  createMetadataEnricher,
  createReviewerAssigner,
  applyMutatingGates,
  enforce,
  type AdmissionPipeline,
  type AdmissionRequest,
  type AdmissionResult,
  type QualityGate,
  type AnyResource,
  type EvaluationContext,
  type AuthorizationHook,
  type MutatingGate,
} from '@ai-sdlc/reference';

export interface PipelineAdmissionConfig {
  qualityGate: QualityGate;
  evaluationContext: Partial<EvaluationContext>;
  authorizer?: AuthorizationHook;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  reviewers?: string[];
  reviewerMinComplexity?: number;
}

/**
 * Create a fully configured admission pipeline for the dogfood orchestrator.
 */
export function createPipelineAdmission(config: PipelineAdmissionConfig): AdmissionPipeline {
  const mutatingGates: MutatingGate[] = [];

  // Inject standard labels (e.g., 'managed-by: ai-sdlc')
  if (config.labels) {
    mutatingGates.push(createLabelInjector(config.labels));
  }

  // Enrich metadata with annotations (e.g., compliance tags)
  if (config.annotations) {
    mutatingGates.push(createMetadataEnricher(config.annotations));
  }

  // Auto-assign reviewers based on complexity threshold
  if (config.reviewers && config.reviewers.length > 0) {
    const reviewerList = config.reviewers;
    mutatingGates.push(createReviewerAssigner(() => reviewerList));
  }

  return {
    authenticator: createAlwaysAuthenticator({
      actor: 'ai-sdlc-pipeline',
      actorType: 'ai-agent',
      roles: ['pipeline-executor'],
      groups: ['ai-agents'],
      scopes: ['repo:read', 'repo:write'],
    }),
    authorizer: config.authorizer,
    mutatingGates: mutatingGates.length > 0 ? mutatingGates : undefined,
    qualityGate: config.qualityGate,
    evaluationContext: config.evaluationContext,
  };
}

/**
 * Run the full admission pipeline on a resource.
 */
export async function admitIssueResource(
  resource: AnyResource,
  pipeline: AdmissionPipeline,
  opts?: { overrideRole?: string; overrideJustification?: string },
): Promise<AdmissionResult> {
  const request: AdmissionRequest = {
    resource,
    token: 'pipeline-token',
    action: 'write',
    target: resource.metadata.name,
    overrideRole: opts?.overrideRole,
    overrideJustification: opts?.overrideJustification,
  };
  return admitResource(request, pipeline);
}

export { admitResource, applyMutatingGates, enforce };
export type { AdmissionPipeline, AdmissionResult, AdmissionRequest };
