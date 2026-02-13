# Core

Core types, validation, provenance tracking, and comparison utilities shared across all AI-SDLC modules.

## Import

```typescript
import {
  // Types
  type ApiVersion,
  type ResourceKind,
  type Metadata,
  type Condition,
  type SecretRef,
  type MetricCondition,
  type Duration,
  type Resource,
  type Pipeline,
  type AgentRole,
  type QualityGate,
  type AutonomyPolicy,
  type AdapterBinding,
  type AnyResource,
  // ... (all resource sub-types)

  // Constants
  API_VERSION,

  // Validation
  validate,
  validateResource,
  type ValidationResult,
  type ValidationError,

  // Provenance
  createProvenance,
  provenanceToAnnotations,
  provenanceFromAnnotations,
  validateProvenance,
  PROVENANCE_ANNOTATION_PREFIX,
  type ProvenanceRecord,
  type ReviewDecision,

  // Comparison
  compareMetric,
  exceedsSeverity,
} from '@ai-sdlc/reference';
```

## Constants

### `API_VERSION`

```typescript
const API_VERSION = 'ai-sdlc.io/v1alpha1';
```

The current API version string. All resources MUST use this value in their `apiVersion` field.

## Types

### Resource Kinds

```typescript
type ResourceKind = 'Pipeline' | 'AgentRole' | 'QualityGate' | 'AutonomyPolicy' | 'AdapterBinding';
```

### `Resource<K, S, St>`

Base generic type for all AI-SDLC resources.

```typescript
interface Resource<K extends ResourceKind, S, St = unknown> {
  apiVersion: ApiVersion;
  kind: K;
  metadata: Metadata;
  spec: S;
  status?: St;
}
```

### `Metadata`

```typescript
interface Metadata {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}
```

### `Condition`

Status condition following the Kubernetes convention.

```typescript
interface Condition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  lastEvaluated?: string;
}
```

### `Duration`

Duration in shorthand (`60s`, `5m`, `2h`, `1d`, `2w`) or ISO 8601 format (`P1D`, `PT1H`).

```typescript
type Duration = string;
```

### `AnyResource`

Union of all five resource types.

```typescript
type AnyResource = Pipeline | AgentRole | QualityGate | AutonomyPolicy | AdapterBinding;
```

### Pipeline Types

| Type | Description |
|---|---|
| `Pipeline` | `Resource<'Pipeline', PipelineSpec, PipelineStatus>` |
| `PipelineSpec` | `{ triggers, providers, stages, routing?, branching?, pullRequest?, notifications? }` |
| `Stage` | `{ name, agent?, qualityGates?, onFailure?, timeout?, credentials?, approval? }` |
| `Trigger` | `{ event, filter? }` |
| `Provider` | `{ type, config? }` |
| `Routing` | `{ complexityThresholds? }` |
| `RoutingStrategy` | `'fully-autonomous' \| 'ai-with-review' \| 'ai-assisted' \| 'human-led'` |
| `FailurePolicy` | `{ strategy, maxRetries?, retryDelay?, notification? }` |
| `ApprovalPolicy` | `{ required, tierOverride?, blocking?, timeout?, onTimeout? }` |

### AgentRole Types

| Type | Description |
|---|---|
| `AgentRole` | `Resource<'AgentRole', AgentRoleSpec, AgentRoleStatus>` |
| `AgentRoleSpec` | `{ role, goal, backstory?, tools, constraints?, handoffs?, skills?, agentCard? }` |
| `AgentConstraints` | `{ maxFilesPerChange?, requireTests?, allowedLanguages?, blockedPaths? }` |
| `Handoff` | `{ target, trigger, contract? }` |
| `Skill` | `{ id, description, tags?, examples? }` |
| `AgentCard` | `{ endpoint, version, securitySchemes? }` |

### QualityGate Types

| Type | Description |
|---|---|
| `QualityGate` | `Resource<'QualityGate', QualityGateSpec, QualityGateStatus>` |
| `Gate` | `{ name, enforcement, rule, override? }` |
| `GateRule` | `MetricRule \| ToolRule \| ReviewerRule \| DocumentationRule \| ProvenanceRule \| ExpressionRule` |
| `EnforcementLevel` | `'advisory' \| 'soft-mandatory' \| 'hard-mandatory'` |
| `GateScope` | `{ repositories?, authorTypes? }` |
| `Evaluation` | `{ pipeline?, timeout?, retryPolicy? }` |

### AutonomyPolicy Types

| Type | Description |
|---|---|
| `AutonomyPolicy` | `Resource<'AutonomyPolicy', AutonomyPolicySpec, AutonomyPolicyStatus>` |
| `AutonomyLevel` | `{ level, name, description?, permissions, guardrails, monitoring, minimumDuration? }` |
| `PromotionCriteria` | `{ minimumTasks, conditions, requiredApprovals }` |
| `DemotionTrigger` | `{ trigger, action, cooldown }` |
| `Permissions` | `{ read, write, execute }` |
| `Guardrails` | `{ requireApproval, maxLinesPerPR?, blockedPaths?, transactionLimit? }` |

### AdapterBinding Types

| Type | Description |
|---|---|
| `AdapterBinding` | `Resource<'AdapterBinding', AdapterBindingSpec, AdapterBindingStatus>` |
| `AdapterInterface` | `'IssueTracker' \| 'SourceControl' \| 'CIPipeline' \| 'CodeAnalysis' \| 'Messenger' \| 'DeploymentTarget' \| 'AuditSink' \| 'Sandbox' \| 'SecretStore' \| 'MemoryStore' \| 'EventBus'` |
| `HealthCheck` | `{ interval?, timeout? }` |

## Functions

### `validate(kind, data)`

Validate a resource document against its JSON Schema.

```typescript
function validate<T extends AnyResource = AnyResource>(
  kind: ResourceKind,
  data: unknown,
): ValidationResult<T>;
```

**Parameters:**
- `kind` — The resource kind to validate against (`'Pipeline'`, `'AgentRole'`, etc.)
- `data` — The resource document to validate

**Returns:** `ValidationResult<T>` with `valid: boolean`, optional `data` (typed), and optional `errors` array.

```typescript
const result = validate('Pipeline', pipelineDoc);
if (result.valid) {
  console.log(result.data); // typed as Pipeline
} else {
  for (const err of result.errors!) {
    console.error(`${err.path}: ${err.message}`);
  }
}
```

### `validateResource(data)`

Validate a resource, inferring the kind from the document's `kind` field.

```typescript
function validateResource(data: unknown): ValidationResult;
```

```typescript
import { parse } from 'yaml';
import { readFileSync } from 'fs';
import { validateResource } from '@ai-sdlc/reference';

const doc = parse(readFileSync('pipeline.yaml', 'utf-8'));
const result = validateResource(doc);
// Automatically detects kind from doc.kind
```

### `createProvenance(partial)`

Create a provenance record with defaults for `timestamp` (now) and `reviewDecision` (`'pending'`).

```typescript
function createProvenance(
  partial: Omit<ProvenanceRecord, 'timestamp' | 'reviewDecision'> & {
    timestamp?: string;
    reviewDecision?: ReviewDecision;
  },
): ProvenanceRecord;
```

```typescript
const prov = createProvenance({
  model: 'claude-sonnet-4-5-20250929',
  tool: 'ai-sdlc-cli',
  promptHash: 'sha256:abc123...',
});
// prov.timestamp is set to now
// prov.reviewDecision defaults to 'pending'
```

### `provenanceToAnnotations(provenance)`

Serialize a provenance record to annotation key-value pairs for storing in resource metadata.

```typescript
function provenanceToAnnotations(provenance: ProvenanceRecord): Record<string, string>;
```

Keys are prefixed with `ai-sdlc.io/provenance-` (e.g., `ai-sdlc.io/provenance-model`).

### `provenanceFromAnnotations(annotations)`

Deserialize a provenance record from annotations. Returns `undefined` if required fields are missing.

```typescript
function provenanceFromAnnotations(
  annotations: Record<string, string>,
): ProvenanceRecord | undefined;
```

### `validateProvenance(provenance)`

Validate that a provenance record has all required fields.

```typescript
function validateProvenance(provenance: Partial<ProvenanceRecord>): {
  valid: boolean;
  missing: string[];
};
```

### `compareMetric(actual, operator, threshold)`

Compare a numeric value against a threshold.

```typescript
function compareMetric(actual: number, operator: string, threshold: number): boolean;
```

Supported operators: `>=`, `<=`, `==`, `!=`, `>`, `<`.

### `exceedsSeverity(actual, max)`

Check if a severity level exceeds a maximum. Ordering: `low < medium < high < critical`.

```typescript
function exceedsSeverity(
  actual: 'low' | 'medium' | 'high' | 'critical',
  max: 'low' | 'medium' | 'high' | 'critical',
): boolean;
```

## Examples

### Validate a YAML resource

```typescript
import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { validateResource } from '@ai-sdlc/reference';

const doc = parse(readFileSync('my-pipeline.yaml', 'utf-8'));
const result = validateResource(doc);

if (!result.valid) {
  for (const err of result.errors!) {
    console.error(`${err.path}: ${err.message} [${err.keyword}]`);
  }
  process.exit(1);
}

console.log(`Valid ${result.data!.kind}: ${result.data!.metadata.name}`);
```

### Attach provenance to a resource

```typescript
import { createProvenance, provenanceToAnnotations } from '@ai-sdlc/reference';

const prov = createProvenance({
  model: 'claude-sonnet-4-5-20250929',
  tool: 'ai-sdlc-cli',
  promptHash: 'sha256:abc123def456',
  humanReviewer: 'alice@example.com',
  reviewDecision: 'approved',
});

// Merge into resource annotations
const resource = {
  apiVersion: 'ai-sdlc.io/v1alpha1' as const,
  kind: 'Pipeline' as const,
  metadata: {
    name: 'my-pipeline',
    annotations: {
      ...provenanceToAnnotations(prov),
    },
  },
  spec: { triggers: [], providers: {}, stages: [] },
};
```
