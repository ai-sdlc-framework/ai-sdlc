/**
 * Composed admission pipeline (PRD Section 10).
 * Chains authentication, authorization, mutating gates, and enforcement
 * into a single pipeline with short-circuit on failure.
 */

import type { AnyResource, QualityGate } from '../core/types.js';
import type { Authenticator, AuthIdentity } from './authentication.js';
import type { AuthorizationHook, AuthorizationResult } from './authorization.js';
import type { MutatingGate, MutatingGateContext } from './mutating-gate.js';
import { applyMutatingGates } from './mutating-gate.js';
import type { EvaluationContext, EnforcementResult } from './enforcement.js';
import { enforce } from './enforcement.js';

export interface AdmissionRequest {
  resource: AnyResource;
  token?: string;
  action?: string;
  target?: string;
  overrideRole?: string;
  overrideJustification?: string;
}

export interface AdmissionPipeline {
  authenticator?: Authenticator;
  authorizer?: AuthorizationHook;
  mutatingGates?: MutatingGate[];
  qualityGate: QualityGate;
  evaluationContext: Partial<EvaluationContext>;
}

export interface AdmissionResult {
  admitted: boolean;
  resource: AnyResource;
  identity?: AuthIdentity;
  authzResult?: AuthorizationResult;
  gateResult?: EnforcementResult;
  error?: string;
}

/**
 * Run the full admission pipeline: authenticate → authorize → mutate → enforce.
 * Short-circuits on failure at any stage.
 */
export async function admitResource(
  request: AdmissionRequest,
  pipeline: AdmissionPipeline,
): Promise<AdmissionResult> {
  let resource = request.resource;
  let identity: AuthIdentity | undefined;

  // Stage 1: Authenticate (optional)
  if (pipeline.authenticator) {
    if (!request.token) {
      return {
        admitted: false,
        resource,
        error: 'Authentication required but no token provided',
      };
    }
    const authResult = await pipeline.authenticator.authenticate(request.token);
    if (!authResult.success) {
      return {
        admitted: false,
        resource,
        error: `Authentication failed: ${authResult.reason ?? 'unknown'}`,
      };
    }
    identity = authResult.identity;
  }

  // Stage 2: Authorize (optional)
  let authzResult: AuthorizationResult | undefined;
  if (pipeline.authorizer) {
    const agent = identity?.actor ?? 'anonymous';
    authzResult = pipeline.authorizer({
      agent,
      action: (request.action ?? 'write') as 'read' | 'write' | 'execute',
      target: request.target ?? resource.metadata.name,
    });
    if (!authzResult.allowed) {
      return {
        admitted: false,
        resource,
        identity,
        authzResult,
        error: `Authorization denied: ${authzResult.reason ?? 'unknown'}`,
      };
    }
  }

  // Stage 3: Mutate (optional)
  if (pipeline.mutatingGates && pipeline.mutatingGates.length > 0) {
    const ctx: MutatingGateContext = {
      authorType: identity?.actorType ?? 'ai-agent',
    };
    resource = applyMutatingGates(resource, pipeline.mutatingGates, ctx);
  }

  // Stage 4: Enforce (required)
  const evalCtx: EvaluationContext = {
    authorType: (identity?.actorType ?? 'ai-agent') as EvaluationContext['authorType'],
    repository: '',
    metrics: {},
    ...pipeline.evaluationContext,
    overrideRole: request.overrideRole ?? pipeline.evaluationContext.overrideRole,
    overrideJustification:
      request.overrideJustification ?? pipeline.evaluationContext.overrideJustification,
  };

  const gateResult = enforce(pipeline.qualityGate, evalCtx);

  return {
    admitted: gateResult.allowed,
    resource,
    identity,
    authzResult,
    gateResult,
  };
}
