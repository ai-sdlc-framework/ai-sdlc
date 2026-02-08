import { describe, it, expect } from 'vitest';
import {
  PipelineBuilder,
  AgentRoleBuilder,
  QualityGateBuilder,
  AutonomyPolicyBuilder,
  AdapterBindingBuilder,
} from './index.js';

describe('PipelineBuilder', () => {
  it('builds minimal pipeline', () => {
    const pipeline = new PipelineBuilder('my-pipeline').build();
    expect(pipeline.apiVersion).toBe('ai-sdlc.io/v1alpha1');
    expect(pipeline.kind).toBe('Pipeline');
    expect(pipeline.metadata.name).toBe('my-pipeline');
    expect(pipeline.spec.stages).toEqual([]);
    expect(pipeline.spec.triggers).toEqual([]);
    expect(pipeline.spec.providers).toEqual({});
  });

  it('builds full pipeline with stages, triggers, providers', () => {
    const pipeline = new PipelineBuilder('ci-pipeline')
      .label('env', 'prod')
      .annotation('ai-sdlc.io/owner', 'team-a')
      .addTrigger({ event: 'pull_request', filter: { branches: ['main'] } })
      .addProvider('github', { type: 'github', config: { org: 'acme' } })
      .addStage({ name: 'build', agent: 'builder' })
      .addStage({ name: 'test', agent: 'tester', qualityGates: ['coverage-gate'] })
      .withRouting({
        complexityThresholds: {
          simple: { min: 0, max: 5, strategy: 'fully-autonomous' },
        },
      })
      .build();

    expect(pipeline.metadata.labels).toEqual({ env: 'prod' });
    expect(pipeline.metadata.annotations).toEqual({ 'ai-sdlc.io/owner': 'team-a' });
    expect(pipeline.spec.triggers).toHaveLength(1);
    expect(pipeline.spec.providers['github'].type).toBe('github');
    expect(pipeline.spec.stages).toHaveLength(2);
    expect(pipeline.spec.stages[1].qualityGates).toEqual(['coverage-gate']);
    expect(pipeline.spec.routing?.complexityThresholds?.['simple'].strategy).toBe(
      'fully-autonomous',
    );
  });

  it('is chainable', () => {
    const builder = new PipelineBuilder('p');
    const result = builder.addStage({ name: 's' }).addTrigger({ event: 'e' });
    expect(result).toBe(builder);
  });
});

describe('AgentRoleBuilder', () => {
  it('builds minimal agent role', () => {
    const role = new AgentRoleBuilder('coder', 'developer', 'Write code').build();
    expect(role.kind).toBe('AgentRole');
    expect(role.spec.role).toBe('developer');
    expect(role.spec.goal).toBe('Write code');
    expect(role.spec.tools).toEqual([]);
  });

  it('builds full agent role', () => {
    const role = new AgentRoleBuilder('senior-dev', 'senior-developer', 'Build features')
      .backstory('10 years of experience')
      .tools(['git', 'npm', 'jest'])
      .withConstraints({ maxFilesPerChange: 10, requireTests: true })
      .addHandoff({ target: 'reviewer', trigger: 'pr-ready' })
      .addSkill({ id: 'typescript', description: 'TypeScript expert' })
      .withAgentCard({ endpoint: 'https://agent.example.com', version: '1.0' })
      .label('team', 'backend')
      .build();

    expect(role.spec.backstory).toBe('10 years of experience');
    expect(role.spec.tools).toEqual(['git', 'npm', 'jest']);
    expect(role.spec.constraints?.maxFilesPerChange).toBe(10);
    expect(role.spec.handoffs).toHaveLength(1);
    expect(role.spec.skills).toHaveLength(1);
    expect(role.spec.agentCard?.endpoint).toBe('https://agent.example.com');
    expect(role.metadata.labels).toEqual({ team: 'backend' });
  });

  it('addTool appends individual tools', () => {
    const role = new AgentRoleBuilder('a', 'r', 'g').addTool('git').addTool('npm').build();
    expect(role.spec.tools).toEqual(['git', 'npm']);
  });
});

describe('QualityGateBuilder', () => {
  it('builds minimal quality gate', () => {
    const gate = new QualityGateBuilder('coverage-gate').build();
    expect(gate.kind).toBe('QualityGate');
    expect(gate.spec.gates).toEqual([]);
  });

  it('builds full quality gate', () => {
    const gate = new QualityGateBuilder('security-gate')
      .withScope({ repositories: ['acme/*'], authorTypes: ['ai-agent'] })
      .addGate({
        name: 'coverage',
        enforcement: 'hard-mandatory',
        rule: { metric: 'coverage', operator: '>=', threshold: 80 },
      })
      .addGate({
        name: 'review',
        enforcement: 'soft-mandatory',
        rule: { minimumReviewers: 2, aiAuthorRequiresExtraReviewer: true },
        override: { requiredRole: 'tech-lead', requiresJustification: true },
      })
      .withEvaluation({ pipeline: 'pre-merge', timeout: '5m' })
      .build();

    expect(gate.spec.scope?.repositories).toEqual(['acme/*']);
    expect(gate.spec.gates).toHaveLength(2);
    expect(gate.spec.evaluation?.pipeline).toBe('pre-merge');
  });
});

describe('AutonomyPolicyBuilder', () => {
  it('builds minimal autonomy policy', () => {
    const policy = new AutonomyPolicyBuilder('default-policy').build();
    expect(policy.kind).toBe('AutonomyPolicy');
    expect(policy.spec.levels).toEqual([]);
    expect(policy.spec.demotionTriggers).toEqual([]);
  });

  it('builds full autonomy policy', () => {
    const policy = new AutonomyPolicyBuilder('progressive-trust')
      .addLevel({
        level: 0,
        name: 'Supervised',
        permissions: { read: ['**'], write: [], execute: [] },
        guardrails: { requireApproval: 'all' },
        monitoring: 'continuous',
        minimumDuration: '2h',
      })
      .addLevel({
        level: 1,
        name: 'Assisted',
        permissions: { read: ['**'], write: ['src/**'], execute: ['test'] },
        guardrails: { requireApproval: 'security-critical-only' },
        monitoring: 'real-time-notification',
      })
      .addPromotionCriteria('0-to-1', {
        minimumTasks: 10,
        conditions: [{ metric: 'approval-rate', operator: '>=', threshold: 90 }],
        requiredApprovals: ['tech-lead'],
      })
      .addDemotionTrigger({
        trigger: 'security-violation',
        action: 'demote-to-0',
        cooldown: '24h',
      })
      .build();

    expect(policy.spec.levels).toHaveLength(2);
    expect(policy.spec.promotionCriteria['0-to-1'].minimumTasks).toBe(10);
    expect(policy.spec.demotionTriggers).toHaveLength(1);
  });
});

describe('AdapterBindingBuilder', () => {
  it('builds minimal adapter binding', () => {
    const binding = new AdapterBindingBuilder(
      'github-binding',
      'SourceControl',
      'github',
      '2.0.0',
    ).build();
    expect(binding.kind).toBe('AdapterBinding');
    expect(binding.spec.interface).toBe('SourceControl');
    expect(binding.spec.type).toBe('github');
    expect(binding.spec.version).toBe('2.0.0');
  });

  it('builds full adapter binding', () => {
    const binding = new AdapterBindingBuilder('sonarqube', 'CodeAnalysis', 'sonarqube', '1.0.0')
      .source('https://registry.ai-sdlc.io/adapters/sonarqube')
      .config({ serverUrl: 'https://sonar.example.com', projectKey: 'my-project' })
      .withHealthCheck({ interval: '30s', timeout: '5s' })
      .label('env', 'production')
      .annotation('ai-sdlc.io/managed-by', 'terraform')
      .build();

    expect(binding.spec.source).toBe('https://registry.ai-sdlc.io/adapters/sonarqube');
    expect(binding.spec.config?.['serverUrl']).toBe('https://sonar.example.com');
    expect(binding.spec.healthCheck?.interval).toBe('30s');
    expect(binding.metadata.labels).toEqual({ env: 'production' });
  });
});
