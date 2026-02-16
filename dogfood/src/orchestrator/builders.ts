/**
 * Resource builder integration — wraps all 5 fluent resource builders and
 * the distribution builder, providing factory functions for programmatic
 * config generation as an alternative to YAML loading.
 */

import {
  PipelineBuilder,
  AgentRoleBuilder,
  QualityGateBuilder,
  AutonomyPolicyBuilder,
  AdapterBindingBuilder,
  parseBuilderManifest,
  validateBuilderManifest,
  buildDistribution,
  API_VERSION,
  type BuilderManifest,
  type ManifestAdapter,
  type ManifestOutput,
  type ResolvedAdapter,
  type DistributionBuildResult,
  type BuildDistributionOptions,
} from '@ai-sdlc/reference';
import {
  DEFAULT_COMPLEXITY_THRESHOLDS,
  DEFAULT_MAX_FILES_PER_CHANGE,
  DEFAULT_REQUIRE_TESTS,
  DEFAULT_BLOCKED_PATHS,
  DEFAULT_MAX_LINES_PER_PR,
  DEFAULT_CONFIG_DIR_NAME,
} from '@ai-sdlc/orchestrator';

// Dogfood-specific defaults (the orchestrator generalized these to empty strings)
const DEFAULT_GITHUB_ORG = 'ai-sdlc-framework';
const DEFAULT_GITHUB_REPO = 'ai-sdlc';
const DEFAULT_GITHUB_REPOSITORY = `${DEFAULT_GITHUB_ORG}/${DEFAULT_GITHUB_REPO}`;

/**
 * Create the default dogfood pipeline resource using the fluent builder.
 */
export function buildDogfoodPipeline() {
  return new PipelineBuilder('dogfood-pipeline')
    .label('managed-by', 'ai-sdlc')
    .annotation('ai-sdlc.io/version', 'v1alpha1')
    .addTrigger({
      event: 'issue.labeled',
      filter: { labels: ['ai-eligible'] },
    })
    .addStage({
      name: 'validate',
      agent: 'code-agent',
      qualityGates: ['issue-quality'],
    })
    .addStage({
      name: 'implement',
      agent: 'code-agent',
      qualityGates: ['issue-quality'],
    })
    .addProvider('issueTracker', {
      type: 'github-issues',
      config: {},
    })
    .addProvider('sourceControl', {
      type: 'github-source',
      config: {},
    })
    .withRouting({
      complexityThresholds: DEFAULT_COMPLEXITY_THRESHOLDS,
    })
    .build();
}

/**
 * Create the default dogfood agent role using the fluent builder.
 */
export function buildDogfoodAgentRole() {
  return new AgentRoleBuilder(
    'code-agent',
    'AI Software Engineer',
    'Implement features and fix bugs autonomously',
  )
    .label('managed-by', 'ai-sdlc')
    .backstory('Expert developer working on the ai-sdlc framework')
    .tools(['Edit', 'Write', 'Read', 'Glob', 'Grep', 'Bash'])
    .withConstraints({
      maxFilesPerChange: DEFAULT_MAX_FILES_PER_CHANGE,
      requireTests: DEFAULT_REQUIRE_TESTS,
      blockedPaths: DEFAULT_BLOCKED_PATHS,
    })
    .addHandoff({
      target: 'review-agent',
      trigger: 'complexity > 5',
    })
    .addSkill({
      id: 'typescript-development',
      description: 'TypeScript and Node.js development expertise',
      tags: ['typescript', 'nodejs', 'testing'],
    })
    .build();
}

/**
 * Create the default dogfood quality gate using the fluent builder.
 */
export function buildDogfoodQualityGate() {
  return new QualityGateBuilder('issue-quality')
    .label('managed-by', 'ai-sdlc')
    .addGate({
      name: 'has-description',
      enforcement: 'hard-mandatory',
      rule: { metric: 'description-length', operator: '>=', threshold: 10 },
    })
    .addGate({
      name: 'complexity-limit',
      enforcement: 'hard-mandatory',
      rule: { metric: 'complexity', operator: '<=', threshold: 3 },
    })
    .addGate({
      name: 'has-acceptance-criteria',
      enforcement: 'soft-mandatory',
      rule: { metric: 'has-acceptance-criteria', operator: '>=', threshold: 1 },
    })
    .withScope({
      repositories: [DEFAULT_GITHUB_REPOSITORY],
      authorTypes: ['ai-agent'],
    })
    .build();
}

/**
 * Create the default dogfood autonomy policy using the fluent builder.
 */
export function buildDogfoodAutonomyPolicy() {
  return new AutonomyPolicyBuilder('progressive-trust')
    .label('managed-by', 'ai-sdlc')
    .addLevel({
      level: 0,
      name: 'supervised',
      permissions: { read: ['**'], write: [], execute: [] },
      guardrails: {
        requireApproval: 'all',
        maxLinesPerPR: DEFAULT_MAX_LINES_PER_PR.level0,
        blockedPaths: ['.github/**', `${DEFAULT_CONFIG_DIR_NAME}/**`],
      },
      monitoring: 'continuous',
    })
    .addLevel({
      level: 1,
      name: 'assisted',
      permissions: { read: ['**'], write: ['src/**'], execute: ['test'] },
      guardrails: {
        requireApproval: 'security-critical-only',
        maxLinesPerPR: DEFAULT_MAX_LINES_PER_PR.level1,
        blockedPaths: DEFAULT_BLOCKED_PATHS,
      },
      monitoring: 'real-time-notification',
    })
    .addLevel({
      level: 2,
      name: 'autonomous',
      permissions: { read: ['**'], write: ['src/**', 'test/**'], execute: ['test', 'lint'] },
      guardrails: {
        requireApproval: 'none',
        maxLinesPerPR: DEFAULT_MAX_LINES_PER_PR.level2,
        blockedPaths: DEFAULT_BLOCKED_PATHS,
      },
      monitoring: 'audit-log',
    })
    .addPromotionCriteria('0-to-1', {
      minimumTasks: 10,
      conditions: [{ metric: 'approval-rate', operator: '>=', threshold: 0.9 }],
      requiredApprovals: ['maintainer'],
    })
    .addDemotionTrigger({
      trigger: 'security-violation',
      action: 'demote-to-0',
      cooldown: '24h',
    })
    .build();
}

/**
 * Create the default dogfood adapter binding using the fluent builder.
 */
export function buildDogfoodAdapterBinding() {
  return new AdapterBindingBuilder('github-adapter', 'IssueTracker', 'github', '1.0.0')
    .label('managed-by', 'ai-sdlc')
    .source(`github:${DEFAULT_GITHUB_REPOSITORY}`)
    .config({ org: DEFAULT_GITHUB_ORG, repo: DEFAULT_GITHUB_REPO })
    .withHealthCheck({ interval: '60s', timeout: '10s' })
    .build();
}

/**
 * Validate and parse a builder manifest YAML string.
 */
export function parsePipelineManifest(yaml: string): BuilderManifest {
  const manifest = parseBuilderManifest(yaml);
  const result = validateBuilderManifest(manifest);
  if (!result.valid) {
    throw new Error(`Invalid manifest: ${result.errors.join(', ')}`);
  }
  return manifest;
}

/**
 * Build a distribution from a manifest.
 */
export async function buildPipelineDistribution(
  manifest: BuilderManifest,
  options?: BuildDistributionOptions,
): Promise<DistributionBuildResult> {
  return buildDistribution(manifest, options);
}

export {
  PipelineBuilder,
  AgentRoleBuilder,
  QualityGateBuilder,
  AutonomyPolicyBuilder,
  AdapterBindingBuilder,
  parseBuilderManifest,
  validateBuilderManifest,
  buildDistribution,
  API_VERSION,
};

export type {
  BuilderManifest,
  ManifestAdapter,
  ManifestOutput,
  ResolvedAdapter,
  DistributionBuildResult,
  BuildDistributionOptions,
};
