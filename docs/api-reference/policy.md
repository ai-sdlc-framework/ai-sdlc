# Policy

Quality gate enforcement, autonomy evaluation, authorization, authentication, mutating gates, expression rules, LLM evaluation, admission control, and policy evaluators.

## Import

```typescript
import {
  // Enforcement
  enforce,
  evaluateGate,
  type EvaluationContext,
  type GateResult,
  type GateVerdict,
  type EnforcementResult,

  // Autonomy
  evaluatePromotion,
  evaluateDemotion,
  parseDuration,
  DEFAULT_COOLDOWN_MS,
  type AgentMetrics,
  type PromotionResult,
  type DemotionResult,

  // Complexity routing
  scoreComplexity,
  routeByComplexity,
  evaluateComplexity,
  DEFAULT_COMPLEXITY_FACTORS,
  DEFAULT_THRESHOLDS,
  type ComplexityInput,
  type ComplexityResult,

  // Authorization
  checkPermission,
  checkConstraints,
  authorize,
  createAuthorizationHook,
  type AuthorizationContext,
  type AuthorizationResult,
  type AuthorizationHook,

  // Authentication
  createTokenAuthenticator,
  createAlwaysAuthenticator,
  type AuthIdentity,
  type Authenticator,

  // Mutating gates
  createLabelInjector,
  createMetadataEnricher,
  createReviewerAssigner,
  applyMutatingGates,
  type MutatingGate,
  type MutatingGateContext,

  // Expression rules
  createSimpleExpressionEvaluator,
  evaluateExpressionRule,
  type ExpressionEvaluator,
  type ExpressionVerdict,

  // LLM evaluation
  evaluateLLMRule,
  createStubLLMEvaluator,
  type LLMEvaluator,
  type LLMEvaluationResult,

  // Admission
  admitResource,
  type AdmissionRequest,
  type AdmissionPipeline,
  type AdmissionResult,

  // Policy evaluators
  createRegoEvaluator,
  createCELEvaluator,
  createABACAuthorizationHook,
  type ABACPolicy,
} from '@ai-sdlc/reference';
```

## Enforcement

### `enforce(qualityGate, ctx)`

Evaluate all gates in a `QualityGate` resource and determine whether the action is allowed.

```typescript
function enforce(qualityGate: QualityGate, ctx: EvaluationContext): EnforcementResult;
```

**Enforcement semantics:**
- **advisory** -- logged but never blocks
- **soft-mandatory** -- blocks unless overridden by authorized role
- **hard-mandatory** -- always blocks on failure, no override possible

**Parameters:**
- `qualityGate` -- A `QualityGate` resource containing one or more gates
- `ctx` -- `EvaluationContext` with metrics, tool results, and override credentials

```typescript
import { enforce } from '@ai-sdlc/reference';

const result = enforce(qualityGate, {
  authorType: 'ai-agent',
  repository: 'org/my-service',
  metrics: { 'line-coverage': 85 },
  toolResults: {
    semgrep: { findings: [] },
  },
  reviewerCount: 2,
});

if (result.allowed) {
  console.log('All gates passed');
} else {
  for (const r of result.results) {
    if (r.verdict === 'fail') {
      console.error(`${r.gate}: ${r.message} [${r.enforcement}]`);
    }
  }
}
```

### `evaluateGate(gate, ctx)`

Evaluate a single gate against the provided context.

```typescript
function evaluateGate(gate: Gate, ctx: EvaluationContext): GateResult;
```

### `EvaluationContext`

```typescript
interface EvaluationContext {
  authorType: 'ai-agent' | 'human' | 'bot' | 'service-account';
  repository: string;
  metrics: Record<string, number>;
  overrideRole?: string;
  overrideJustification?: string;
  toolResults?: Record<string, { findings: { severity: Severity }[] }>;
  reviewerCount?: number;
  changedFiles?: string[];
  docFiles?: string[];
  provenance?: { attribution?: boolean; humanReviewed?: boolean };
}
```

## Autonomy

### `evaluatePromotion(policy, agent)`

Evaluate whether an agent is eligible for promotion to the next autonomy level.

```typescript
function evaluatePromotion(policy: AutonomyPolicy, agent: AgentMetrics): PromotionResult;
```

Checks minimum duration at current level, demotion cooldown, task count, metric conditions, and required approvals.

```typescript
import { evaluatePromotion } from '@ai-sdlc/reference';

const result = evaluatePromotion(autonomyPolicy, {
  name: 'code-agent',
  currentLevel: 0,
  totalTasksCompleted: 25,
  metrics: { 'recommendation-acceptance-rate': 0.95 },
  approvals: ['engineering-manager'],
});

if (result.eligible) {
  console.log(`Promote from level ${result.fromLevel} to ${result.toLevel}`);
} else {
  console.log('Unmet conditions:', result.unmetConditions);
}
```

### `evaluateDemotion(policy, agent, activeTrigger)`

Evaluate whether an agent should be demoted based on a trigger event.

```typescript
function evaluateDemotion(
  policy: AutonomyPolicy,
  agent: AgentMetrics,
  activeTrigger: string,
): DemotionResult;
```

### `parseDuration(d)`

Parse a duration string to milliseconds. Supports shorthand (`60s`, `5m`, `2h`, `1d`, `2w`) and ISO 8601 (`P1D`, `PT1H`).

```typescript
function parseDuration(d: Duration): number;
```

```typescript
parseDuration('2w');   // 1_209_600_000
parseDuration('300s'); // 300_000
parseDuration('P1D');  // 86_400_000
```

### `AgentMetrics`

```typescript
interface AgentMetrics {
  name: string;
  currentLevel: number;
  totalTasksCompleted: number;
  metrics: Record<string, number>;
  approvals: string[];
  promotedAt?: Date;
  demotedAt?: Date;
}
```

## Complexity Routing

### `routeByComplexity(input)`

Score a task's complexity and return the appropriate routing strategy.

```typescript
function routeByComplexity(input: ComplexityInput): ComplexityResult;
```

### `scoreComplexity(input)`

Calculate a raw complexity score (1-10) from input factors.

## Authorization

### `authorize(agentRole, ctx)`

Check whether an agent is authorized for an action based on its role constraints.

```typescript
function authorize(agentRole: AgentRole, ctx: AuthorizationContext): AuthorizationResult;
```

### `createAuthorizationHook(agentRoles)`

Create a reusable `AuthorizationHook` function from a set of agent roles.

```typescript
function createAuthorizationHook(
  agentRoles: Map<string, AgentRole>,
): AuthorizationHook;
```

The returned hook is a function: `(ctx: AuthorizationContext) => AuthorizationResult`.

### `createABACAuthorizationHook(policy)`

Create an Attribute-Based Access Control authorization hook.

```typescript
function createABACAuthorizationHook(policy: ABACPolicy): AuthorizationHook;
```

## Authentication

### `createTokenAuthenticator(tokens)`

Create an authenticator that validates bearer tokens against a known map.

```typescript
function createTokenAuthenticator(
  tokens: Map<string, AuthIdentity>,
): Authenticator;
```

### `createAlwaysAuthenticator(identity)`

Create an authenticator that always returns a fixed identity (useful for testing).

## Mutating Gates

Mutating gates transform resources before they proceed through the pipeline.

### `applyMutatingGates(resource, gates, ctx)`

Apply a sequence of mutating gates to a resource, returning the mutated copy.

```typescript
function applyMutatingGates(
  resource: AnyResource,
  gates: MutatingGate[],
  ctx: MutatingGateContext,
): AnyResource;
```

### Built-in Mutating Gates

| Factory | Description |
|---|---|
| `createLabelInjector(labels)` | Injects labels into resource metadata |
| `createMetadataEnricher(annotations)` | Adds annotations to resource metadata |
| `createReviewerAssigner(rules)` | Assigns reviewers based on change characteristics |

## Expression Rules

### `evaluateExpressionRule(rule, ctx)`

Evaluate a gate rule that uses an expression string.

```typescript
function evaluateExpressionRule(
  rule: ExpressionRule,
  ctx: EvaluationContext,
): ExpressionVerdict;
```

### `createSimpleExpressionEvaluator()`

Create an evaluator that supports simple comparison expressions (e.g., `metrics['coverage'] >= 80`).

## LLM Evaluation

### `evaluateLLMRule(rule, evaluator)`

Evaluate a gate rule using an LLM for qualitative assessment.

```typescript
function evaluateLLMRule(
  rule: LLMEvaluationRule,
  evaluator: LLMEvaluator,
): Promise<LLMEvaluationResult>;
```

### `createStubLLMEvaluator(results)`

Create a stub LLM evaluator for testing that returns predetermined results.

## Admission Control

### `admitResource(request, pipeline)`

Run a resource through an admission pipeline (authentication, authorization, mutation, validation).

```typescript
function admitResource(
  request: AdmissionRequest,
  pipeline: AdmissionPipeline,
): Promise<AdmissionResult>;
```

## Policy Evaluators

### `createRegoEvaluator()`

Create a policy evaluator supporting a subset of Rego syntax.

### `createCELEvaluator()`

Create a policy evaluator supporting a subset of Common Expression Language.
