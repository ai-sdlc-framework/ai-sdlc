/**
 * Builder examples — constructing all 5 resource types using the fluent API.
 *
 * Run: npx tsx docs/examples/builder-examples.ts
 */

import {
  PipelineBuilder,
  AgentRoleBuilder,
  QualityGateBuilder,
  AutonomyPolicyBuilder,
  AdapterBindingBuilder,
  validateResource,
} from '@ai-sdlc/reference';

// ── Pipeline ──────────────────────────────────────────────────────────

const pipeline = new PipelineBuilder('feature-delivery')
  .label('team', 'platform')
  .label('environment', 'production')
  .annotation('ai-sdlc.io/managed-by', 'dogfood')
  .addTrigger({ event: 'issue.assigned', filter: { labels: ['ai-ready'] } })
  .addTrigger({ event: 'issue.labeled', filter: { labels: ['ai-eligible'] } })
  .addProvider('issueTracker', { type: 'linear', config: { teamId: 'ENG' } })
  .addProvider('sourceControl', { type: 'github', config: { org: 'my-org' } })
  .addStage({
    name: 'implement',
    agent: 'code-agent',
    qualityGates: ['test-coverage', 'security-scan'],
    onFailure: { strategy: 'retry', maxRetries: 2, retryDelay: '30s' },
  })
  .addStage({
    name: 'review',
    agent: 'reviewer-agent',
    qualityGates: ['human-approval'],
  })
  .addStage({
    name: 'deploy',
    agent: 'deploy-agent',
    qualityGates: ['integration-tests'],
  })
  .withRouting({
    complexityThresholds: {
      low: { min: 1, max: 3, strategy: 'fully-autonomous' },
      medium: { min: 4, max: 6, strategy: 'ai-with-review' },
      high: { min: 7, max: 8, strategy: 'ai-assisted' },
      critical: { min: 9, max: 10, strategy: 'human-led' },
    },
  })
  .withBranching({ pattern: 'ai/{{issue-id}}-{{slug}}', targetBranch: 'main', cleanup: 'on-merge' })
  .withPullRequest({ titleTemplate: '[AI] {{issue-title}}', includeProvenance: true })
  .build();

console.log('Pipeline:', pipeline.metadata.name, '— stages:', pipeline.spec.stages.length);

// ── AgentRole ─────────────────────────────────────────────────────────

const codeAgent = new AgentRoleBuilder(
  'code-agent',
  'Senior Software Engineer',
  'Implement well-tested features from issue specifications',
)
  .label('role', 'engineer')
  .backstory('Experienced TypeScript and Python developer. Values clean, focused changes.')
  .tools(['code-editor', 'terminal', 'test-runner', 'git-client', 'file-search'])
  .withConstraints({
    maxFilesPerChange: 20,
    requireTests: true,
    allowedLanguages: ['typescript', 'python', 'yaml'],
    blockedPaths: ['.env*', 'infrastructure/**', '*.pem'],
  })
  .addHandoff({
    target: 'reviewer-agent',
    trigger: 'implementation complete and tests passing',
    contract: {
      schema: './contracts/impl-to-review.json',
      requiredFields: ['prUrl', 'testResults', 'coverageReport', 'changeSummary'],
    },
  })
  .addSkill({
    id: 'implement-feature',
    description: 'Implements features from issue specifications with tests.',
    tags: ['implementation', 'feature', 'testing'],
    examples: [
      {
        input: 'Add JWT authentication',
        output: 'Auth module with login/logout, JWT middleware, 95% coverage',
      },
    ],
  })
  .addSkill({
    id: 'fix-bug',
    description: 'Diagnoses and fixes bugs with regression tests.',
    tags: ['bugfix', 'debugging'],
  })
  .build();

console.log('AgentRole:', codeAgent.metadata.name, '— tools:', codeAgent.spec.tools.length);

// ── QualityGate ───────────────────────────────────────────────────────

const gate = new QualityGateBuilder('ai-code-standards')
  .withScope({ repositories: ['org/service-*'], authorTypes: ['ai-agent'] })
  .addGate({
    name: 'test-coverage',
    enforcement: 'soft-mandatory',
    rule: { metric: 'line-coverage', operator: '>=', threshold: 80 },
    override: { requiredRole: 'engineering-manager', requiresJustification: true },
  })
  .addGate({
    name: 'security-scan',
    enforcement: 'hard-mandatory',
    rule: { tool: 'semgrep', maxSeverity: 'medium', rulesets: ['owasp-top-10'] },
  })
  .addGate({
    name: 'human-review',
    enforcement: 'soft-mandatory',
    rule: { minimumReviewers: 2, aiAuthorRequiresExtraReviewer: true },
    override: { requiredRole: 'engineering-manager', requiresJustification: true },
  })
  .addGate({
    name: 'provenance-check',
    enforcement: 'advisory',
    rule: { requireAttribution: true, requireHumanReview: true },
  })
  .withEvaluation({
    pipeline: 'pre-merge',
    timeout: '300s',
    retryPolicy: { maxRetries: 3, backoff: 'exponential' },
  })
  .build();

console.log('QualityGate:', gate.metadata.name, '— gates:', gate.spec.gates.length);

// ── AutonomyPolicy ────────────────────────────────────────────────────

const policy = new AutonomyPolicyBuilder('standard-progression')
  .addLevel({
    level: 0,
    name: 'Intern',
    description: 'Read-only observation, no code generation',
    permissions: { read: ['*'], write: [], execute: [] },
    guardrails: { requireApproval: 'all' },
    monitoring: 'continuous',
    minimumDuration: '2w',
  })
  .addLevel({
    level: 1,
    name: 'Junior',
    description: 'Recommend changes with mandatory human approval',
    permissions: { read: ['*'], write: ['draft-pr', 'comment'], execute: ['test-suite'] },
    guardrails: {
      requireApproval: 'all',
      maxLinesPerPR: 200,
      blockedPaths: ['**/auth/**', '**/payment/**'],
    },
    monitoring: 'continuous',
    minimumDuration: '4w',
  })
  .addLevel({
    level: 2,
    name: 'Senior',
    description: 'Execute within guardrails with real-time notification',
    permissions: {
      read: ['*'],
      write: ['branch', 'pr', 'comment'],
      execute: ['test-suite', 'lint', 'build'],
    },
    guardrails: { requireApproval: 'security-critical-only', maxLinesPerPR: 500 },
    monitoring: 'real-time-notification',
    minimumDuration: '8w',
  })
  .addLevel({
    level: 3,
    name: 'Principal',
    description: 'Autonomous within domain, continuous validation',
    permissions: {
      read: ['*'],
      write: ['branch', 'pr', 'comment', 'merge-non-critical'],
      execute: ['test-suite', 'lint', 'build', 'deploy-staging'],
    },
    guardrails: { requireApproval: 'architecture-changes-only', maxLinesPerPR: 1000 },
    monitoring: 'audit-log',
    minimumDuration: null,
  })
  .addPromotionCriteria('0-to-1', {
    minimumTasks: 20,
    conditions: [
      { metric: 'recommendation-acceptance-rate', operator: '>=', threshold: 0.9 },
      { metric: 'security-incidents', operator: '==', threshold: 0 },
    ],
    requiredApprovals: ['engineering-manager'],
  })
  .addPromotionCriteria('1-to-2', {
    minimumTasks: 50,
    conditions: [
      { metric: 'pr-approval-rate', operator: '>=', threshold: 0.9 },
      { metric: 'rollback-rate', operator: '<=', threshold: 0.02 },
    ],
    requiredApprovals: ['engineering-manager', 'security-lead'],
  })
  .addDemotionTrigger({
    trigger: 'critical-security-incident',
    action: 'demote-to-0',
    cooldown: '4w',
  })
  .addDemotionTrigger({
    trigger: 'rollback-rate-exceeds-5-percent',
    action: 'demote-one-level',
    cooldown: '2w',
  })
  .build();

console.log('AutonomyPolicy:', policy.metadata.name, '— levels:', policy.spec.levels.length);

// ── AdapterBinding ────────────────────────────────────────────────────

const githubBinding = new AdapterBindingBuilder('github-source', 'SourceControl', 'github', '1.0.0')
  .label('adapter', 'github')
  .source('registry.ai-sdlc.io/adapters/github@1.0.0')
  .config({ org: 'my-org', repo: 'my-service' })
  .withHealthCheck({ interval: '60s', timeout: '10s' })
  .build();

console.log(
  'AdapterBinding:',
  githubBinding.metadata.name,
  '— interface:',
  githubBinding.spec.interface,
);

// ── Validate all resources ────────────────────────────────────────────

const resources = [pipeline, codeAgent, gate, policy, githubBinding];
for (const resource of resources) {
  const result = validateResource(resource);
  const status = result.valid ? 'VALID' : 'INVALID';
  console.log(`  ${resource.kind}/${resource.metadata.name}: ${status}`);
  if (!result.valid) {
    for (const err of result.errors!) {
      console.error(`    ${err.path}: ${err.message}`);
    }
  }
}
