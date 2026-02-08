import { describe, it, expect } from 'vitest';
import type { QualityGate, AnyResource } from '../core/types.js';
import { admitResource, type AdmissionPipeline, type AdmissionRequest } from './admission.js';
import { createTokenAuthenticator, type AuthIdentity } from './authentication.js';
import type { AuthorizationHook } from './authorization.js';
import { createLabelInjector } from './mutating-gate.js';

const testIdentity: AuthIdentity = {
  actor: 'agent-a',
  actorType: 'ai-agent',
  roles: ['developer'],
  groups: [],
  scopes: ['write'],
};

const passingGate: QualityGate = {
  apiVersion: 'ai-sdlc.io/v1alpha1',
  kind: 'QualityGate',
  metadata: { name: 'pass-gate', labels: {}, annotations: {} },
  spec: {
    gates: [
      {
        name: 'coverage',
        enforcement: 'advisory',
        rule: { metric: 'coverage', operator: '>=', threshold: 80 },
      },
    ],
  },
};

const failingGate: QualityGate = {
  apiVersion: 'ai-sdlc.io/v1alpha1',
  kind: 'QualityGate',
  metadata: { name: 'fail-gate', labels: {}, annotations: {} },
  spec: {
    gates: [
      {
        name: 'coverage',
        enforcement: 'hard-mandatory',
        rule: { metric: 'coverage', operator: '>=', threshold: 80 },
      },
    ],
  },
};

const testResource: AnyResource = {
  apiVersion: 'ai-sdlc.io/v1alpha1',
  kind: 'Pipeline',
  metadata: { name: 'test', labels: {}, annotations: {} },
  spec: { stages: [], triggers: [], providers: {} },
} as AnyResource;

function makeRequest(overrides?: Partial<AdmissionRequest>): AdmissionRequest {
  return { resource: testResource, ...overrides };
}

describe('admitResource', () => {
  it('admits when all stages pass', async () => {
    const pipeline: AdmissionPipeline = {
      qualityGate: passingGate,
      evaluationContext: { metrics: { coverage: 90 } },
    };

    const result = await admitResource(makeRequest(), pipeline);
    expect(result.admitted).toBe(true);
    expect(result.gateResult).toBeDefined();
  });

  it('rejects on authentication failure', async () => {
    const tokenMap = new Map<string, AuthIdentity>();
    const pipeline: AdmissionPipeline = {
      authenticator: createTokenAuthenticator(tokenMap),
      qualityGate: passingGate,
      evaluationContext: {},
    };

    const result = await admitResource(makeRequest({ token: 'bad-token' }), pipeline);
    expect(result.admitted).toBe(false);
    expect(result.error).toContain('Authentication failed');
  });

  it('rejects when no token but authenticator configured', async () => {
    const tokenMap = new Map<string, AuthIdentity>([['valid', testIdentity]]);
    const pipeline: AdmissionPipeline = {
      authenticator: createTokenAuthenticator(tokenMap),
      qualityGate: passingGate,
      evaluationContext: {},
    };

    const result = await admitResource(makeRequest(), pipeline);
    expect(result.admitted).toBe(false);
    expect(result.error).toContain('no token provided');
  });

  it('rejects on authorization failure', async () => {
    const authorizer: AuthorizationHook = () => ({
      allowed: false,
      reason: 'Insufficient permissions',
    });

    const pipeline: AdmissionPipeline = {
      authorizer,
      qualityGate: passingGate,
      evaluationContext: {},
    };

    const result = await admitResource(makeRequest(), pipeline);
    expect(result.admitted).toBe(false);
    expect(result.error).toContain('Authorization denied');
    expect(result.authzResult?.allowed).toBe(false);
  });

  it('applies mutating gates before enforcement', async () => {
    const labelInjector = createLabelInjector({ env: 'production' });

    const pipeline: AdmissionPipeline = {
      mutatingGates: [labelInjector],
      qualityGate: passingGate,
      evaluationContext: { metrics: { coverage: 90 } },
    };

    const result = await admitResource(makeRequest(), pipeline);
    expect(result.admitted).toBe(true);
    expect(result.resource.metadata.labels?.['env']).toBe('production');
    // Original resource should not be modified
    expect(testResource.metadata.labels?.['env']).toBeUndefined();
  });

  it('rejects on gate failure', async () => {
    const pipeline: AdmissionPipeline = {
      qualityGate: failingGate,
      evaluationContext: { metrics: { coverage: 50 } },
    };

    const result = await admitResource(makeRequest(), pipeline);
    expect(result.admitted).toBe(false);
    expect(result.gateResult?.allowed).toBe(false);
  });

  it('passes identity through all stages', async () => {
    const tokenMap = new Map([['token-1', testIdentity]]);
    const authorizer: AuthorizationHook = (ctx) => {
      return { allowed: ctx.agent === 'agent-a' };
    };

    const pipeline: AdmissionPipeline = {
      authenticator: createTokenAuthenticator(tokenMap),
      authorizer,
      qualityGate: passingGate,
      evaluationContext: { metrics: { coverage: 90 } },
    };

    const result = await admitResource(makeRequest({ token: 'token-1' }), pipeline);
    expect(result.admitted).toBe(true);
    expect(result.identity?.actor).toBe('agent-a');
  });

  it('short-circuits: gate not evaluated on auth failure', async () => {
    const tokenMap = new Map<string, AuthIdentity>();
    const pipeline: AdmissionPipeline = {
      authenticator: createTokenAuthenticator(tokenMap),
      qualityGate: failingGate,
      evaluationContext: {},
    };

    const result = await admitResource(makeRequest({ token: 'bad' }), pipeline);
    expect(result.admitted).toBe(false);
    expect(result.gateResult).toBeUndefined();
  });

  it('works with no optional stages', async () => {
    const pipeline: AdmissionPipeline = {
      qualityGate: passingGate,
      evaluationContext: { metrics: { coverage: 100 } },
    };

    const result = await admitResource(makeRequest(), pipeline);
    expect(result.admitted).toBe(true);
    expect(result.identity).toBeUndefined();
    expect(result.authzResult).toBeUndefined();
  });

  it('passes override role/justification to enforcement', async () => {
    const overrideGate: QualityGate = {
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'QualityGate',
      metadata: { name: 'override-gate', labels: {}, annotations: {} },
      spec: {
        gates: [
          {
            name: 'coverage',
            enforcement: 'soft-mandatory',
            rule: { metric: 'coverage', operator: '>=', threshold: 80 },
            override: { requiredRole: 'tech-lead', requiresJustification: true },
          },
        ],
      },
    };

    const pipeline: AdmissionPipeline = {
      qualityGate: overrideGate,
      evaluationContext: { metrics: { coverage: 50 } },
    };

    const result = await admitResource(
      makeRequest({ overrideRole: 'tech-lead', overrideJustification: 'Critical fix' }),
      pipeline,
    );
    expect(result.admitted).toBe(true);
    expect(result.gateResult?.results[0].verdict).toBe('override');
  });
});
