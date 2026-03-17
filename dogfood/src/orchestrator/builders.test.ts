import { describe, it, expect } from 'vitest';
import {
  buildDogfoodPipeline,
  buildDogfoodAgentRole,
  buildDogfoodQualityGate,
  buildDogfoodAutonomyPolicy,
  buildDogfoodAdapterBinding,
  PipelineBuilder,
  AgentRoleBuilder,
  QualityGateBuilder,
  AutonomyPolicyBuilder,
  AdapterBindingBuilder,
  parseBuilderManifest,
  validateBuilderManifest,
  parsePipelineManifest,
  buildPipelineDistribution,
  API_VERSION,
} from './builders.js';

describe('Resource builders', () => {
  describe('buildDogfoodPipeline()', () => {
    it('creates a valid pipeline resource', () => {
      const pipeline = buildDogfoodPipeline();
      expect(pipeline.kind).toBe('Pipeline');
      expect(pipeline.apiVersion).toBe('ai-sdlc.io/v1alpha1');
      expect(pipeline.metadata.name).toBe('dogfood-pipeline');
      expect(pipeline.spec.stages.length).toBeGreaterThan(0);
      expect(pipeline.spec.triggers.length).toBeGreaterThan(0);
    });

    it('includes routing configuration', () => {
      const pipeline = buildDogfoodPipeline();
      expect(pipeline.spec.routing).toBeDefined();
      expect(pipeline.spec.routing!.complexityThresholds).toBeDefined();
      expect(Object.keys(pipeline.spec.routing!.complexityThresholds!).length).toBe(4);
    });

    it('includes providers', () => {
      const pipeline = buildDogfoodPipeline();
      expect(pipeline.spec.providers).toBeDefined();
      expect(pipeline.spec.providers['issueTracker']).toBeDefined();
      expect(pipeline.spec.providers['sourceControl']).toBeDefined();
    });
  });

  describe('buildDogfoodAgentRole()', () => {
    it('creates a valid agent role resource', () => {
      const role = buildDogfoodAgentRole();
      expect(role.kind).toBe('AgentRole');
      expect(role.metadata.name).toBe('code-agent');
      expect(role.spec.role).toBe('AI Software Engineer');
      expect(role.spec.tools.length).toBeGreaterThan(0);
    });

    it('includes constraints and handoffs', () => {
      const role = buildDogfoodAgentRole();
      expect(role.spec.constraints).toBeDefined();
      expect(role.spec.constraints!.maxFilesPerChange).toBe(15);
      expect(role.spec.handoffs!.length).toBe(1);
    });

    it('includes skills', () => {
      const role = buildDogfoodAgentRole();
      expect(role.spec.skills!.length).toBe(1);
      expect(role.spec.skills![0].id).toBe('typescript-development');
    });
  });

  describe('buildDogfoodQualityGate()', () => {
    it('creates a valid quality gate resource', () => {
      const gate = buildDogfoodQualityGate();
      expect(gate.kind).toBe('QualityGate');
      expect(gate.metadata.name).toBe('issue-quality');
      expect(gate.spec.gates.length).toBe(3);
    });

    it('includes scope configuration', () => {
      const gate = buildDogfoodQualityGate();
      expect(gate.spec.scope).toBeDefined();
      expect(gate.spec.scope!.authorTypes).toContain('ai-agent');
    });
  });

  describe('buildDogfoodAutonomyPolicy()', () => {
    it('creates a valid autonomy policy resource', () => {
      const policy = buildDogfoodAutonomyPolicy();
      expect(policy.kind).toBe('AutonomyPolicy');
      expect(policy.metadata.name).toBe('progressive-trust');
      expect(policy.spec.levels.length).toBe(3);
    });

    it('includes promotion criteria and demotion triggers', () => {
      const policy = buildDogfoodAutonomyPolicy();
      expect(Object.keys(policy.spec.promotionCriteria).length).toBeGreaterThan(0);
      expect(policy.spec.demotionTriggers.length).toBeGreaterThan(0);
    });
  });

  describe('buildDogfoodAdapterBinding()', () => {
    it('creates a valid adapter binding resource', () => {
      const binding = buildDogfoodAdapterBinding();
      expect(binding.kind).toBe('AdapterBinding');
      expect(binding.metadata.name).toBe('github-adapter');
      expect(binding.spec.interface).toBe('IssueTracker');
      expect(binding.spec.type).toBe('github');
    });

    it('includes health check', () => {
      const binding = buildDogfoodAdapterBinding();
      expect(binding.spec.healthCheck).toBeDefined();
    });
  });

  describe('fluent builder APIs', () => {
    it('PipelineBuilder supports method chaining', () => {
      const p = new PipelineBuilder('test')
        .label('env', 'test')
        .annotation('note', 'test')
        .addStage({ name: 's1', agent: 'a1' })
        .build();
      expect(p.metadata.labels!['env']).toBe('test');
    });

    it('AgentRoleBuilder supports method chaining', () => {
      const r = new AgentRoleBuilder('test', 'role', 'goal')
        .addTool('Read')
        .addTool('Write')
        .build();
      expect(r.spec.tools).toEqual(['Read', 'Write']);
    });

    it('QualityGateBuilder supports method chaining', () => {
      const g = new QualityGateBuilder('test')
        .addGate({
          name: 'g1',
          enforcement: 'advisory',
          rule: { metric: 'm', operator: '>=', threshold: 1 },
        })
        .build();
      expect(g.spec.gates).toHaveLength(1);
    });

    it('AutonomyPolicyBuilder supports method chaining', () => {
      const p = new AutonomyPolicyBuilder('test')
        .addLevel({
          level: 0,
          name: 'supervised',
          permissions: { read: ['**'], write: [], execute: [] },
          guardrails: { requireApproval: 'all', maxLinesPerPR: 100 },
          monitoring: 'continuous',
        })
        .build();
      expect(p.spec.levels).toHaveLength(1);
    });

    it('AdapterBindingBuilder supports method chaining', () => {
      const b = new AdapterBindingBuilder('test', 'IssueTracker', 'github', '1.0.0')
        .config({ org: 'test' })
        .build();
      expect(b.spec.config).toEqual({ org: 'test' });
    });
  });

  describe('API_VERSION', () => {
    it('matches the expected version string', () => {
      expect(API_VERSION).toBe('ai-sdlc.io/v1alpha1');
    });

    it('is used in built resources', () => {
      const pipeline = buildDogfoodPipeline();
      expect(pipeline.apiVersion).toBe(API_VERSION);
    });
  });

  describe('distribution builder', () => {
    it('parseBuilderManifest parses YAML', () => {
      const yaml = `
spec_version: "1.0"
adapters: []
output:
  format: yaml
  directory: ./out
`;
      const manifest = parseBuilderManifest(yaml);
      expect(manifest.spec_version).toBe('1.0');
    });

    it('validateBuilderManifest returns validation result', () => {
      const manifest = parseBuilderManifest(`
spec_version: "1.0"
adapters: []
output:
  format: yaml
  directory: ./out
`);
      const result = validateBuilderManifest(manifest);
      expect(typeof result.valid).toBe('boolean');
    });
  });

  describe('parsePipelineManifest()', () => {
    it('parses a valid manifest YAML and returns the manifest object', () => {
      const yaml = `
spec_version: "1.0"
adapters:
  - name: test-adapter
    version: "1.0.0"
    source: "local:./adapters/test"
output:
  name: test-dist
  version: "1.0.0"
  format: yaml
  directory: ./out
`;
      const manifest = parsePipelineManifest(yaml);
      expect(manifest.spec_version).toBe('1.0');
      expect(manifest.adapters).toHaveLength(1);
      expect(manifest.adapters[0].name).toBe('test-adapter');
    });

    it('throws when the manifest is invalid (no adapters)', () => {
      const yaml = `
spec_version: "1.0"
adapters: []
output:
  name: test
  version: "1.0.0"
  format: yaml
  directory: ./out
`;
      expect(() => parsePipelineManifest(yaml)).toThrow('Invalid manifest');
    });

    it('throws when the manifest is missing spec_version', () => {
      const yaml = `
adapters:
  - name: a
    version: "1.0.0"
    source: "local:./a"
output:
  name: test
  version: "1.0.0"
  format: yaml
  directory: ./out
`;
      // parseBuilderManifest throws directly for missing spec_version
      expect(() => parsePipelineManifest(yaml)).toThrow();
    });
  });

  describe('buildPipelineDistribution()', () => {
    it('builds a distribution from a valid manifest', async () => {
      const yaml = `
spec_version: "1.0"
adapters:
  - name: test-adapter
    version: "1.0.0"
    source: "local:./adapters/test"
output:
  name: test-dist
  version: "1.0.0"
  format: yaml
  directory: ./out
`;
      const manifest = parsePipelineManifest(yaml);
      const result = await buildPipelineDistribution(manifest);
      expect(result).toBeDefined();
      expect(typeof result.valid).toBe('boolean');
    });

    it('returns a result object with expected shape', async () => {
      const yaml = `
spec_version: "1.0"
adapters:
  - name: my-adapter
    version: "2.0.0"
    source: "local:./adapters/my"
output:
  name: my-dist
  version: "2.0.0"
  format: yaml
  directory: ./dist
`;
      const manifest = parsePipelineManifest(yaml);
      const result = await buildPipelineDistribution(manifest, {});
      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('manifest');
      expect(result).toHaveProperty('resolved');
      expect(result).toHaveProperty('errors');
      expect(result).toHaveProperty('warnings');
    });
  });
});
