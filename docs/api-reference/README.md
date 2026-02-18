# API Reference

Complete reference for the AI-SDLC packages.

## Orchestrator (`@ai-sdlc/orchestrator`)

The orchestrator runtime — CLI, agent runners, codebase analysis, and state store.

| Module | Description |
|---|---|
| [Runners](runners.md) | Agent runners (Claude Code, Copilot, Cursor, Codex, GenericLLM) and runner registry |

## SDK (`@ai-sdlc/reference`)

The TypeScript reference implementation, structured as a single package with 12 modules:

```
@ai-sdlc/reference
├── core/         — Types, validation, provenance, comparison
├── builders/     — Fluent resource builders for all 5 resource types
├── policy/       — Enforcement, autonomy, authorization, admission
├── adapters/     — Interface contracts, built-in + stub adapters
├── agents/       — Orchestration patterns, execution, memory, discovery
├── reconciler/   — Controller loop, diff, resource reconcilers
├── audit/        — Hash-chained audit log with pluggable sinks
├── metrics/      — Metric store, standard metrics, instrumentation
├── telemetry/    — OpenTelemetry tracing, structured logging
├── security/     — Sandbox, JIT credentials, kill switch, approvals
└── compliance/   — Regulatory framework mapping and checking
```

## Import Patterns

All exports are available from the root:

```typescript
import { validate, enforce, PipelineBuilder } from '@ai-sdlc/reference';
```

## Module Reference

| Module | Package | Description | Key Exports |
|---|---|---|---|
| [Runners](runners.md) | `@ai-sdlc/orchestrator` | Agent runners and registry | `ClaudeCodeRunner`, `CopilotRunner`, `CursorRunner`, `CodexRunner`, `GenericLLMRunner`, `RunnerRegistry`, `createRunnerRegistry` |
| [Core](core.md) | `@ai-sdlc/reference` | Types, validation, provenance | `validate`, `validateResource`, `createProvenance`, `API_VERSION` |
| [Builders](builders.md) | `@ai-sdlc/reference` | Fluent resource construction | `PipelineBuilder`, `AgentRoleBuilder`, `QualityGateBuilder`, `AutonomyPolicyBuilder`, `AdapterBindingBuilder` |
| [Policy](policy.md) | `@ai-sdlc/reference` | Enforcement and authorization | `enforce`, `evaluatePromotion`, `authorize`, `admitResource`, `parseDuration` |
| [Adapters](adapters.md) | `@ai-sdlc/reference` | External tool integrations | `IssueTracker`, `SourceControl`, `CIPipeline`, `createAdapterRegistry` |
| [Agents](agents.md) | `@ai-sdlc/reference` | Multi-agent orchestration | `sequential`, `parallel`, `executeOrchestration`, `validateHandoff` |
| [Reconciler](reconciler.md) | `@ai-sdlc/reference` | Controller loop pattern | `ReconcilerLoop`, `reconcileOnce`, `resourceFingerprint` |
| [Audit](audit.md) | `@ai-sdlc/reference` | Tamper-evident audit logging | `createAuditLog`, `createFileSink`, `computeEntryHash` |
| [Metrics](metrics.md) | `@ai-sdlc/reference` | Metric collection and querying | `createMetricStore`, `STANDARD_METRICS` |
| [Telemetry](telemetry.md) | `@ai-sdlc/reference` | OpenTelemetry + structured logging | `withSpan`, `createConsoleLogger`, `createBufferLogger` |
| [Security](security.md) | `@ai-sdlc/reference` | Enterprise security primitives | `Sandbox`, `KillSwitch`, `JITCredentialIssuer`, `ApprovalWorkflow` |
| [Compliance](compliance.md) | `@ai-sdlc/reference` | Regulatory framework coverage | `checkCompliance`, `checkAllFrameworks`, `getAllControlIds` |

## Resource Types

Five core resource types, all sharing the same envelope:

| Kind | Schema | Spec Reference |
|---|---|---|
| Pipeline | [pipeline.schema.json](../../spec/schemas/pipeline.schema.json) | [spec.md#5.1](../../spec/spec.md#51-pipeline) |
| AgentRole | [agent-role.schema.json](../../spec/schemas/agent-role.schema.json) | [spec.md#5.2](../../spec/spec.md#52-agentrole) |
| QualityGate | [quality-gate.schema.json](../../spec/schemas/quality-gate.schema.json) | [spec.md#5.3](../../spec/spec.md#53-qualitygate) |
| AutonomyPolicy | [autonomy-policy.schema.json](../../spec/schemas/autonomy-policy.schema.json) | [spec.md#5.4](../../spec/spec.md#54-autonomypolicy) |
| AdapterBinding | [adapter-binding.schema.json](../../spec/schemas/adapter-binding.schema.json) | [spec.md#5.5](../../spec/spec.md#55-adapterbinding) |

Common definitions (metadata, conditions, secretRef, duration) are in [common.schema.json](../../spec/schemas/common.schema.json).

## Quick Start

```typescript
import {
  PipelineBuilder,
  QualityGateBuilder,
  enforce,
  validateResource,
} from '@ai-sdlc/reference';

// Build a pipeline
const pipeline = new PipelineBuilder('my-pipeline')
  .addTrigger({ event: 'issue.assigned' })
  .addProvider('issueTracker', { type: 'linear' })
  .addStage({ name: 'implement', agent: 'code-agent' })
  .build();

// Validate it
const result = validateResource(pipeline);
console.log(result.valid); // true

// Build and enforce a quality gate
const gate = new QualityGateBuilder('standards')
  .addGate({
    name: 'coverage',
    enforcement: 'soft-mandatory',
    rule: { metric: 'line-coverage', operator: '>=', threshold: 80 },
  })
  .build();

const enforcement = enforce(gate, {
  authorType: 'ai-agent',
  repository: 'org/repo',
  metrics: { 'line-coverage': 85 },
});
console.log(enforcement.allowed); // true
```

## Adapter Interfaces

See [adapters.md](../../spec/adapters.md#2-interface-contracts) for the full normative interface contracts.
