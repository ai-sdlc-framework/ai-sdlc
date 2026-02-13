# Builders

Fluent builder API for constructing all five AI-SDLC resource types with type-safe chaining and sensible defaults.

## Import

```typescript
import {
  PipelineBuilder,
  AgentRoleBuilder,
  QualityGateBuilder,
  AutonomyPolicyBuilder,
  AdapterBindingBuilder,
  // Distribution builder
  parseBuilderManifest,
  validateBuilderManifest,
  buildDistribution,
  type BuilderManifest,
  type DistributionBuildResult,
} from '@ai-sdlc/reference';
```

## Classes

### `PipelineBuilder`

Fluently construct a `Pipeline` resource.

```typescript
class PipelineBuilder {
  constructor(name: string);
  label(key: string, value: string): this;
  annotation(key: string, value: string): this;
  addStage(stage: Stage): this;
  addTrigger(trigger: Trigger): this;
  addProvider(name: string, provider: Provider): this;
  withRouting(routing: Routing): this;
  withBranching(config: BranchingConfig): this;
  withPullRequest(config: PullRequestConfig): this;
  withNotifications(config: NotificationsConfig): this;
  build(): Pipeline;
}
```

**Example:**

```typescript
import { PipelineBuilder } from '@ai-sdlc/reference';

const pipeline = new PipelineBuilder('feature-delivery')
  .label('team', 'platform')
  .addTrigger({ event: 'issue.assigned', filter: { labels: ['ai-ready'] } })
  .addProvider('issueTracker', { type: 'linear', config: { teamId: 'ENG' } })
  .addProvider('sourceControl', { type: 'github' })
  .addStage({
    name: 'implement',
    agent: 'code-agent',
    qualityGates: ['test-coverage', 'security-scan'],
  })
  .addStage({
    name: 'review',
    agent: 'reviewer-agent',
    qualityGates: ['human-approval'],
  })
  .withRouting({
    complexityThresholds: {
      low: { min: 1, max: 3, strategy: 'fully-autonomous' },
      medium: { min: 4, max: 6, strategy: 'ai-with-review' },
      high: { min: 7, max: 10, strategy: 'human-led' },
    },
  })
  .build();
```

### `AgentRoleBuilder`

Fluently construct an `AgentRole` resource.

```typescript
class AgentRoleBuilder {
  constructor(name: string, role: string, goal: string);
  label(key: string, value: string): this;
  annotation(key: string, value: string): this;
  backstory(backstory: string): this;
  addTool(tool: string): this;
  tools(tools: string[]): this;
  withConstraints(constraints: AgentConstraints): this;
  addHandoff(handoff: Handoff): this;
  addSkill(skill: Skill): this;
  withAgentCard(card: AgentCard): this;
  build(): AgentRole;
}
```

**Example:**

```typescript
import { AgentRoleBuilder } from '@ai-sdlc/reference';

const agent = new AgentRoleBuilder(
  'code-agent',
  'Senior Software Engineer',
  'Implement features with thorough test coverage',
)
  .backstory('Experienced TypeScript developer focused on clean code.')
  .tools(['code-editor', 'terminal', 'test-runner', 'git-client'])
  .withConstraints({
    maxFilesPerChange: 20,
    requireTests: true,
    allowedLanguages: ['typescript', 'python'],
    blockedPaths: ['.env*', 'infrastructure/**'],
  })
  .addHandoff({
    target: 'review-agent',
    trigger: 'implementation complete and tests passing',
    contract: {
      schema: './contracts/impl-to-review.json',
      requiredFields: ['prUrl', 'testResults'],
    },
  })
  .addSkill({
    id: 'implement-feature',
    description: 'Implements features from issue specifications.',
    tags: ['implementation', 'feature'],
  })
  .build();
```

### `QualityGateBuilder`

Fluently construct a `QualityGate` resource.

```typescript
class QualityGateBuilder {
  constructor(name: string);
  label(key: string, value: string): this;
  annotation(key: string, value: string): this;
  addGate(gate: Gate): this;
  withScope(scope: GateScope): this;
  withEvaluation(evaluation: Evaluation): this;
  build(): QualityGate;
}
```

**Example:**

```typescript
import { QualityGateBuilder } from '@ai-sdlc/reference';

const gate = new QualityGateBuilder('code-standards')
  .withScope({
    repositories: ['org/service-*'],
    authorTypes: ['ai-agent'],
  })
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
  .withEvaluation({
    pipeline: 'pre-merge',
    timeout: '300s',
    retryPolicy: { maxRetries: 3, backoff: 'exponential' },
  })
  .build();
```

### `AutonomyPolicyBuilder`

Fluently construct an `AutonomyPolicy` resource.

```typescript
class AutonomyPolicyBuilder {
  constructor(name: string);
  label(key: string, value: string): this;
  annotation(key: string, value: string): this;
  addLevel(level: AutonomyLevel): this;
  addPromotionCriteria(key: string, criteria: PromotionCriteria): this;
  addDemotionTrigger(trigger: DemotionTrigger): this;
  build(): AutonomyPolicy;
}
```

**Example:**

```typescript
import { AutonomyPolicyBuilder } from '@ai-sdlc/reference';

const policy = new AutonomyPolicyBuilder('standard-progression')
  .addLevel({
    level: 0,
    name: 'Intern',
    permissions: { read: ['*'], write: [], execute: [] },
    guardrails: { requireApproval: 'all' },
    monitoring: 'continuous',
    minimumDuration: '2w',
  })
  .addLevel({
    level: 1,
    name: 'Junior',
    permissions: { read: ['*'], write: ['draft-pr'], execute: ['test-suite'] },
    guardrails: { requireApproval: 'all', maxLinesPerPR: 200 },
    monitoring: 'continuous',
    minimumDuration: '4w',
  })
  .addPromotionCriteria('0-to-1', {
    minimumTasks: 20,
    conditions: [{ metric: 'approval-rate', operator: '>=', threshold: 0.9 }],
    requiredApprovals: ['engineering-manager'],
  })
  .addDemotionTrigger({
    trigger: 'critical-security-incident',
    action: 'demote-to-0',
    cooldown: '4w',
  })
  .build();
```

### `AdapterBindingBuilder`

Fluently construct an `AdapterBinding` resource.

```typescript
class AdapterBindingBuilder {
  constructor(name: string, iface: AdapterInterface, type: string, version: string);
  label(key: string, value: string): this;
  annotation(key: string, value: string): this;
  source(source: string): this;
  config(config: Record<string, unknown>): this;
  withHealthCheck(healthCheck: HealthCheck): this;
  build(): AdapterBinding;
}
```

**Example:**

```typescript
import { AdapterBindingBuilder } from '@ai-sdlc/reference';

const binding = new AdapterBindingBuilder(
  'github-source',
  'SourceControl',
  'github',
  '1.0.0',
)
  .source('registry.ai-sdlc.io/adapters/github@1.0.0')
  .config({ org: 'my-org', repo: 'my-repo' })
  .withHealthCheck({ interval: '60s', timeout: '10s' })
  .build();
```

## Distribution Builder

Build custom adapter distributions from a YAML manifest.

### `parseBuilderManifest(yaml)`

Parse a YAML manifest string into a `BuilderManifest` object.

### `validateBuilderManifest(manifest)`

Validate a parsed manifest for structural correctness.

### `buildDistribution(manifest, options?)`

Build a distribution bundle from a manifest.

```typescript
function buildDistribution(
  manifest: BuilderManifest,
  options?: BuildDistributionOptions,
): DistributionBuildResult;
```
