/**
 * Admission pipeline module — composes authentication, authorization,
 * mutating gates, and enforcement into a single admission flow.
 */

import {
  admitResource,
  createAlwaysAuthenticator,
  createTokenAuthenticator,
  createLabelInjector,
  createMetadataEnricher,
  createReviewerAssigner,
  applyMutatingGates,
  enforce,
  validate,
  type AdmissionPipeline,
  type AdmissionRequest,
  type AdmissionResult,
  type QualityGate,
  type AnyResource,
  type EvaluationContext,
  type AuthorizationHook,
  type MutatingGate,
  type AuthIdentity,
  type Authenticator,
  type AuthenticationResult,
  type ResourceKind,
  type ValidationResult,
} from '@ai-sdlc/reference';

export interface PipelineAdmissionConfig {
  qualityGate: QualityGate;
  evaluationContext: Partial<EvaluationContext>;
  authorizer?: AuthorizationHook;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  reviewers?: string[];
  reviewerMinComplexity?: number;
  /** Override the authenticator (defaults to token-based when GITHUB_TOKEN is set). */
  authenticator?: Authenticator;
}

const DEFAULT_PIPELINE_IDENTITY: AuthIdentity = {
  actor: 'ai-sdlc-pipeline',
  actorType: 'ai-agent',
  roles: ['pipeline-executor'],
  groups: ['ai-agents'],
  scopes: ['repo:read', 'repo:write'],
};

/**
 * Create a pipeline authenticator.
 * When `GITHUB_TOKEN` is set, uses token-based authentication with an
 * identity derived from `GITHUB_ACTOR`. Falls back to always-authenticator
 * for local dev and test environments.
 */
export function createPipelineAuthenticator(): Authenticator {
  const token = process.env.GITHUB_TOKEN;
  const actor = process.env.GITHUB_ACTOR;

  if (token && actor) {
    const identity: AuthIdentity = {
      actor,
      actorType: 'bot',
      roles: ['pipeline-executor'],
      groups: ['github-actions'],
      scopes: ['repo:read', 'repo:write'],
    };
    const tokenMap = new Map<string, AuthIdentity>([[token, identity]]);
    return createTokenAuthenticator(tokenMap);
  }

  return createAlwaysAuthenticator(DEFAULT_PIPELINE_IDENTITY);
}

/**
 * Authenticate a request token against the pipeline authenticator.
 */
export async function authenticateRequest(
  authenticator: Authenticator,
  token: string,
): Promise<AuthenticationResult> {
  return authenticator.authenticate(token);
}

/**
 * Validate pipeline resources (Pipeline, AgentRole, etc.) against JSON Schemas.
 * Returns validation results for each resource.
 */
export function validatePipelineResources(
  resources: Array<{ kind: ResourceKind; data: unknown }>,
): ValidationResult[] {
  return resources.map(({ kind, data }) => validate(kind, data));
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

  const authenticator = config.authenticator ?? createPipelineAuthenticator();

  return {
    authenticator,
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
export type {
  AdmissionPipeline,
  AdmissionResult,
  AdmissionRequest,
  Authenticator,
  AuthIdentity,
  AuthenticationResult,
  ValidationResult,
};
