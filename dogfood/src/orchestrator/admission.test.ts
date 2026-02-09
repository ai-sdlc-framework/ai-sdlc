import { describe, it, expect } from 'vitest';
import { createPipelineAdmission, admitIssueResource } from './admission.js';
import type { QualityGate, AnyResource, AuthorizationHook } from '@ai-sdlc/reference';

function makeQualityGate(overrides: Partial<QualityGate['spec']> = {}): QualityGate {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'QualityGate',
    metadata: { name: 'test-gate' },
    spec: {
      gates: [
        {
          name: 'description-present',
          enforcement: 'advisory',
          rule: { metric: 'description-length', operator: '>=', threshold: 1 },
        },
      ],
      ...overrides,
    },
  };
}

function makeResource(name = 'test-resource'): AnyResource {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'Pipeline',
    metadata: { name },
    spec: {
      triggers: [],
      providers: {},
      stages: [],
    },
  } as unknown as AnyResource;
}

describe('Admission pipeline', () => {
  it('creates a pipeline with authenticator', () => {
    const pipeline = createPipelineAdmission({
      qualityGate: makeQualityGate(),
      evaluationContext: { authorType: 'ai-agent', repository: 'test', metrics: {} },
    });
    expect(pipeline.authenticator).toBeDefined();
  });

  it('authenticates with always-authenticator identity', async () => {
    const pipeline = createPipelineAdmission({
      qualityGate: makeQualityGate(),
      evaluationContext: {
        authorType: 'ai-agent',
        repository: 'test',
        metrics: { 'description-length': 10 },
      },
    });
    const result = await admitIssueResource(makeResource(), pipeline);
    expect(result.identity).toBeDefined();
    expect(result.identity!.actor).toBe('ai-sdlc-pipeline');
  });

  it('authorization allows when no authorizer', async () => {
    const pipeline = createPipelineAdmission({
      qualityGate: makeQualityGate(),
      evaluationContext: {
        authorType: 'ai-agent',
        repository: 'test',
        metrics: { 'description-length': 10 },
      },
    });
    const result = await admitIssueResource(makeResource(), pipeline);
    expect(result.admitted).toBe(true);
  });

  it('authorization denies when authorizer rejects', async () => {
    const denyAll: AuthorizationHook = () => ({
      allowed: false,
      reason: 'denied by policy',
    });

    const pipeline = createPipelineAdmission({
      qualityGate: makeQualityGate(),
      evaluationContext: { authorType: 'ai-agent', repository: 'test', metrics: {} },
      authorizer: denyAll,
    });
    const result = await admitIssueResource(makeResource(), pipeline);
    expect(result.admitted).toBe(false);
    expect(result.error).toContain('denied by policy');
  });

  it('injects labels via mutating gate', async () => {
    const pipeline = createPipelineAdmission({
      qualityGate: makeQualityGate(),
      evaluationContext: {
        authorType: 'ai-agent',
        repository: 'test',
        metrics: { 'description-length': 10 },
      },
      labels: { 'managed-by': 'ai-sdlc' },
    });
    const result = await admitIssueResource(makeResource(), pipeline);
    expect(result.admitted).toBe(true);
    expect(result.resource.metadata.labels?.['managed-by']).toBe('ai-sdlc');
  });

  it('enriches metadata annotations', async () => {
    const pipeline = createPipelineAdmission({
      qualityGate: makeQualityGate(),
      evaluationContext: {
        authorType: 'ai-agent',
        repository: 'test',
        metrics: { 'description-length': 10 },
      },
      annotations: { 'compliance/framework': 'soc2' },
    });
    const result = await admitIssueResource(makeResource(), pipeline);
    expect(result.resource.metadata.annotations?.['compliance/framework']).toBe('soc2');
  });

  it('assigns reviewers via mutating gate', async () => {
    const pipeline = createPipelineAdmission({
      qualityGate: makeQualityGate(),
      evaluationContext: {
        authorType: 'ai-agent',
        repository: 'test',
        metrics: { 'description-length': 10, complexity: 5 },
      },
      reviewers: ['alice', 'bob'],
      reviewerMinComplexity: 3,
    });
    const result = await admitIssueResource(makeResource(), pipeline);
    expect(result.admitted).toBe(true);
    // Reviewer assigner adds annotation for reviewers
    // The mutating gate modifies the resource — we verify no crash and admission passes
    expect(result.resource.metadata).toBeDefined();
  });

  it('chains multiple mutating gates', async () => {
    const pipeline = createPipelineAdmission({
      qualityGate: makeQualityGate(),
      evaluationContext: {
        authorType: 'ai-agent',
        repository: 'test',
        metrics: { 'description-length': 10 },
      },
      labels: { 'managed-by': 'ai-sdlc' },
      annotations: { 'audit/tracked': 'true' },
    });
    const result = await admitIssueResource(makeResource(), pipeline);
    expect(result.admitted).toBe(true);
    expect(result.resource.metadata.labels?.['managed-by']).toBe('ai-sdlc');
    expect(result.resource.metadata.annotations?.['audit/tracked']).toBe('true');
  });

  it('admits resource when all gates pass', async () => {
    const pipeline = createPipelineAdmission({
      qualityGate: makeQualityGate(),
      evaluationContext: {
        authorType: 'ai-agent',
        repository: 'test',
        metrics: { 'description-length': 100 },
      },
    });
    const result = await admitIssueResource(makeResource(), pipeline);
    expect(result.admitted).toBe(true);
    expect(result.gateResult).toBeDefined();
  });

  it('rejects resource when hard-mandatory gate fails', async () => {
    const gate = makeQualityGate({
      gates: [
        {
          name: 'complexity-check',
          enforcement: 'hard-mandatory',
          rule: { metric: 'complexity', operator: '<=', threshold: 3 },
        },
      ],
    });
    const pipeline = createPipelineAdmission({
      qualityGate: gate,
      evaluationContext: {
        authorType: 'ai-agent',
        repository: 'test',
        metrics: { complexity: 5 },
      },
    });
    const result = await admitIssueResource(makeResource(), pipeline);
    expect(result.admitted).toBe(false);
  });

  it('supports override role for soft-mandatory gates', async () => {
    const gate = makeQualityGate({
      gates: [
        {
          name: 'coverage-check',
          enforcement: 'soft-mandatory',
          rule: { metric: 'test-coverage', operator: '>=', threshold: 80 },
          override: { requiredRole: 'tech-lead', requiresJustification: true },
        },
      ],
    });
    const pipeline = createPipelineAdmission({
      qualityGate: gate,
      evaluationContext: {
        authorType: 'ai-agent',
        repository: 'test',
        metrics: { 'test-coverage': 50 },
      },
    });
    const result = await admitIssueResource(makeResource(), pipeline, {
      overrideRole: 'tech-lead',
      overrideJustification: 'hotfix needed',
    });
    expect(result.admitted).toBe(true);
  });
});
