# Agents

Agent orchestration patterns, execution engine, handoff validation, memory management, and agent discovery.

## Import

```typescript
import {
  // Orchestration patterns
  sequential,
  parallel,
  hybrid,
  hierarchical,
  swarm,
  type OrchestrationPattern,
  type OrchestrationStep,
  type OrchestrationPlan,

  // Execution
  executeOrchestration,
  validateHandoff,
  validateHandoffContract,
  simpleSchemaValidate,
  type StepResult,
  type OrchestrationResult,
  type TaskFn,
  type ExecutionOptions,
  type HandoffValidationError,

  // Memory
  createAgentMemory,
  createFileLongTermMemory,
  createFileEpisodicMemory,
  createInMemoryMemoryStore,
  type AgentMemory,
  type MemoryStore,
  type MemoryEntry,
  type WorkingMemory,
  type ShortTermMemory,
  type LongTermMemory,
  type EpisodicMemory,

  // Discovery
  createAgentDiscovery,
  matchAgentBySkill,
  createStubAgentCardFetcher,
  type AgentDiscovery,
  type AgentFilter,
  type A2AAgentCard,
} from '@ai-sdlc/reference';
```

## Orchestration Patterns

Five pattern builders create `OrchestrationPlan` instances from `AgentRole` resources.

### `sequential(agents)`

Build a plan where agents execute in order. Each step depends on the previous.

```typescript
function sequential(agents: AgentRole[]): OrchestrationPlan;
```

```typescript
const plan = sequential([codeAgent, reviewAgent, deployAgent]);
// implement → review → deploy
```

### `parallel(agents)`

Build a plan where all agents execute concurrently with no dependencies.

```typescript
function parallel(agents: AgentRole[]): OrchestrationPlan;
```

### `hybrid(dispatcher, specialists)`

Build a plan where a dispatcher agent routes work to specialist agents.

```typescript
function hybrid(dispatcher: AgentRole, specialists: AgentRole[]): OrchestrationPlan;
```

### `hierarchical(manager, workers)`

Build a plan where a manager agent delegates to worker agents.

```typescript
function hierarchical(manager: AgentRole, workers: AgentRole[]): OrchestrationPlan;
```

### `swarm(agents)`

Build a plan from agents that reference each other via handoff declarations. Dependencies are derived from handoff targets.

```typescript
function swarm(agents: AgentRole[]): OrchestrationPlan;
```

## Execution

### `executeOrchestration(plan, agents, taskFn, options?)`

Execute an orchestration plan. Steps run concurrently when their dependencies are satisfied.

```typescript
function executeOrchestration(
  plan: OrchestrationPlan,
  agents: Map<string, AgentRole>,
  taskFn: TaskFn,
  options?: ExecutionOptions,
): Promise<OrchestrationResult>;
```

**Parameters:**
- `plan` -- An `OrchestrationPlan` from one of the pattern builders
- `agents` -- Map of agent name to `AgentRole` resource
- `taskFn` -- Function that executes a single agent step: `(agent: AgentRole, input?: unknown) => Promise<unknown>`
- `options` -- Optional authorization hook and audit log

**Returns:** `OrchestrationResult` with `plan`, `stepResults[]`, and `success` boolean.

```typescript
import { sequential, executeOrchestration } from '@ai-sdlc/reference';

const plan = sequential([codeAgent, reviewAgent]);
const agents = new Map([
  ['code-agent', codeAgent],
  ['review-agent', reviewAgent],
]);

const result = await executeOrchestration(plan, agents, async (agent, input) => {
  console.log(`Executing ${agent.metadata.name}`);
  return { status: 'done', output: `${agent.metadata.name} completed` };
});

console.log('Success:', result.success);
for (const step of result.stepResults) {
  console.log(`  ${step.agent}: ${step.state}`);
}
```

### `ExecutionOptions`

```typescript
interface ExecutionOptions {
  authorize?: AuthorizationHook;
  auditLog?: AuditLog;
}
```

When `authorize` is provided, each step is checked before execution. Denied steps fail with an authorization error and are recorded in the audit log.

## Handoff Validation

### `validateHandoff(from, to, payload, schemaResolver?)`

Validate a handoff between two agents. Checks that a handoff declaration exists and that all required fields are present in the payload.

```typescript
function validateHandoff(
  from: AgentRole,
  to: AgentRole,
  payload: Record<string, unknown>,
  schemaResolver?: SchemaResolver,
): HandoffValidationError | null;
```

Returns `null` if valid, or a `HandoffValidationError` describing the problem.

```typescript
const error = validateHandoff(codeAgent, reviewAgent, {
  prUrl: 'https://github.com/org/repo/pull/42',
  testResults: { passed: 100, failed: 0, skipped: 2 },
});

if (error) {
  console.error(`Handoff failed: ${error.message}`);
}
```

### `validateHandoffContract(handoff, payload, schemaResolver?)`

Validate a handoff payload against its contract schema.

### `simpleSchemaValidate(schema, data, path?)`

Lightweight structural JSON Schema validator. Checks `type`, `required`, and `properties` without a full AJV dependency.

## Memory

### `createAgentMemory(options)`

Create a multi-tier agent memory system with working, short-term, long-term, and episodic tiers.

### `createFileLongTermMemory(dir)`

Create a file-backed long-term memory store that persists across sessions.

### `createFileEpisodicMemory(dir)`

Create a file-backed episodic memory store for recording agent experiences.

### `createInMemoryMemoryStore()`

Create an in-memory store for testing.

### Memory Types

```typescript
interface MemoryEntry {
  key: string;
  value: unknown;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

interface AgentMemory {
  working: WorkingMemory;
  shortTerm: ShortTermMemory;
  longTerm: LongTermMemory;
  episodic: EpisodicMemory;
}
```

## Discovery

### `createAgentDiscovery(fetcher?)`

Create an agent discovery service for finding agents by skill, role, or capability.

### `matchAgentBySkill(agent, query)`

Check if an agent matches a skill-based query.

### `createStubAgentCardFetcher(cards)`

Create a stub fetcher that returns predetermined A2A agent cards (for testing).
