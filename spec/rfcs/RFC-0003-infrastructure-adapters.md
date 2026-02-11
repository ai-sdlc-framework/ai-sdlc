# RFC-0003: Infrastructure Provider Adapters

**Status:** Draft
**Author:** AI-SDLC Contributors
**Created:** 2026-02-10
**Updated:** 2026-02-10
**Target Spec Version:** v1alpha1

---

## Summary

This RFC proposes extending the `AdapterBinding` resource to cover five infrastructure concerns that are currently hardcoded in the reference implementation: audit storage, sandboxing, secret management, agent memory persistence, and event delivery. Today these are baked into concrete implementations (JSONL files, GitHub Codespaces, `process.env`, JSON files on disk, Node.js `EventEmitter`) with no adapter abstraction layer. This RFC adds five new interface types to the adapter system, making infrastructure as pluggable as SDLC tooling.

## Motivation

The AI-SDLC spec's core premise is tool-agnostic composability: swap `type: linear` for `type: jira` in an `AdapterBinding` and the pipeline keeps working. This promise holds for the six SDLC interface types (`IssueTracker`, `SourceControl`, `CIPipeline`, `CodeAnalysis`, `Messenger`, `DeploymentTarget`) but breaks completely for infrastructure concerns.

The reference implementation makes five hardcoded infrastructure choices:

| # | Concern | Current Implementation | Problem |
|---|---------|----------------------|---------|
| 1 | **Audit storage** | JSONL file via `appendFileSync` | Cannot use cloud-native audit systems (CloudWatch, Datadog, Splunk) |
| 2 | **Sandboxing** | GitHub Codespaces API | Cannot use Docker, Firecracker, or Kata Containers |
| 3 | **Secret management** | `process.env` / GitHub Secrets | Cannot use Vault, AWS Secrets Manager, or 1Password |
| 4 | **Agent memory** | JSON files on disk | Cannot use Redis, DynamoDB, or PostgreSQL |
| 5 | **Event delivery** | Node.js `EventEmitter` | Cannot use NATS, Kafka, or cloud pub/sub |

Users who need different infrastructure backends must modify reference code directly, violating the adapter model and creating maintenance burden.

**Evidence from dogfooding:** The dogfood pipeline (`dogfood/src/orchestrator/adapters.ts`) registers nine SDLC adapter stubs via the adapter registry but directly imports `createFileAuditLog`, `resolveSecret`, and `createWebhookBridge` as bare functions — these are not adapter-resolved.

## Goals

- Add five new adapter interface types to `AdapterBinding`: `AuditSink`, `Sandbox`, `SecretStore`, `MemoryStore`, `EventBus`
- Define typed interface contracts for each, following the existing adapter pattern
- Provide at least one stub implementation per interface for testing
- Register infrastructure adapters in the adapter registry alongside SDLC adapters
- Maintain full backward compatibility with existing resources and implementations

## Non-Goals

- Replacing the existing concrete implementations (file sink, GitHub Codespaces, etc.) — they remain as adapter implementations
- Defining transport-level concerns (HTTP endpoints, message formats, wire protocols)
- Mandating specific infrastructure providers — the spec defines interfaces, not implementations
- Adding infrastructure-specific configuration schemas (e.g., S3 bucket settings) — those belong in adapter `config`
- Modifying the six existing SDLC interface types

## Proposal

### 1. Extended Interface Enum

The `AdapterBinding.spec.interface` field's enum is extended from 6 to 11 values:

```
IssueTracker, SourceControl, CIPipeline, CodeAnalysis, Messenger, DeploymentTarget,
AuditSink, Sandbox, SecretStore, MemoryStore, EventBus
```

The first six values are **SDLC adapters** (external tool integrations). The last five are **infrastructure adapters** (runtime concerns). This distinction is informative, not normative — both categories use the same `AdapterBinding` resource model and adapter registry.

### 2. AuditSink Interface

<!-- Source: PRD Section 15.4 -->

Adapters for audit log storage and retrieval. The existing `AuditSink` interface (which has only `write()`) is enhanced with optional query, rotation, and lifecycle methods.

```
write(entry: AuditEntry): void
query?(filter: AuditFilter): AuditEntry[]
rotate?(): void
close?(): void
```

The `write()` method is the only MUST-implement method. `query()`, `rotate()`, and `close()` are MAY-implement for backends that support them.

### 3. Sandbox Interface

<!-- Source: PRD Section 15 -->

Adapters for agent task isolation. The existing `Sandbox` interface is unchanged:

```
isolate(taskId: string, constraints: SandboxConstraints): string
destroy(sandboxId: string): void
getStatus(sandboxId: string): SandboxStatus
```

This interface is already well-defined in the reference implementation. The change is adding it to the adapter registry system so it can be declared via `AdapterBinding`.

### 4. SecretStore Interface

<!-- Source: PRD Section 15.2 -->

Adapters for secret resolution and management. This is a new interface — currently, `resolveSecret()` is a bare function reading `process.env`.

```
get(name: string): string | undefined
getRequired(name: string): string
set?(name: string, value: string, ttl?: number): void
delete?(name: string): void
```

`get()` and `getRequired()` are MUST-implement. `set()` and `delete()` are MAY-implement for stores that support write operations (e.g., Vault dynamic secrets).

### 5. MemoryStore Interface

<!-- Source: PRD Section 13.3 -->

Persistence backend for the five-tier agent memory model. The tier interfaces (`WorkingMemory`, `LongTermMemory`, etc.) remain unchanged — `MemoryStore` is the storage layer underneath them.

```
read(key: string): unknown | undefined
write(key: string, value: unknown): void
delete(key: string): void
list(prefix?: string): string[]
```

All four methods are MUST-implement. This is intentionally a simple key-value interface that can be backed by files, Redis, DynamoDB, or any other storage system.

### 6. EventBus Interface

<!-- Source: PRD Section 9 -->

Adapters for event publication and subscription. This replaces direct `EventEmitter` usage with a topic-based publish/subscribe interface.

```
publish(topic: string, payload: unknown): void
subscribe(topic: string, handler: (payload: unknown) => void): Unsubscribe
```

`subscribe()` returns an unsubscribe function. Both methods are MUST-implement.

---

## Design Details

### Schema Changes

The `adapter-binding.schema.json` `interface` enum is extended:

```json
{
  "interface": {
    "type": "string",
    "enum": [
      "IssueTracker", "SourceControl", "CIPipeline",
      "CodeAnalysis", "Messenger", "DeploymentTarget",
      "AuditSink", "Sandbox", "SecretStore", "MemoryStore", "EventBus"
    ],
    "description": "The abstract contract name."
  }
}
```

### Behavioral Changes

#### Adapter Resolution

Infrastructure adapters are resolved using the same `AdapterRegistry` as SDLC adapters. The registry's `list(interfaceFilter)` method works identically for infrastructure interfaces:

```typescript
registry.list('AuditSink');    // → all registered audit sink adapters
registry.list('SecretStore');   // → all registered secret store adapters
```

#### Reconciliation Loop Impact

No changes to reconciliation semantics. Infrastructure adapters are resolved at pipeline initialization time, not during reconciliation. The reconciler continues to interact with infrastructure through the existing typed interfaces.

### Migration Path

All five new interface values are additive. Existing `AdapterBinding` resources validate without modification. Implementations that do not recognize the new interface types MAY ignore them, though they SHOULD log a warning.

Existing concrete implementations (file sink, GitHub Codespaces sandbox, etc.) continue to work as before. The adapter abstraction is opt-in: implementations MAY resolve infrastructure from adapter bindings or MAY continue to use direct construction.

---

## Backward Compatibility

- **Not a breaking change.** The schema change is additive (new enum values).
- Existing `AdapterBinding` resources validate against the updated schema without modification.
- Existing code that switches on `AdapterInterface` will encounter new string values — implementations SHOULD handle unknown interface types gracefully.
- No changes to the existing six SDLC interface contracts.

---

## Alternatives Considered

### Alternative 1: Separate InfrastructureBinding Resource

Create a new 6th resource type specifically for infrastructure concerns, distinct from `AdapterBinding`.

**Rejected because:** Infrastructure concerns follow the same adapter pattern — a typed interface with pluggable implementations discovered from a registry. Creating a separate resource type would duplicate the entire adapter registration, discovery, and configuration model. The distinction between "SDLC adapter" and "infrastructure adapter" is informative, not structural.

### Alternative 2: Configuration-Only Approach

Instead of adapter interfaces, use a configuration-driven approach where infrastructure backends are selected by configuration keys (e.g., `audit.backend: s3`).

**Rejected because:** This loses the typed interface guarantee that makes adapters composable. A configuration key cannot enforce that an audit backend implements `write()` with the correct signature. The adapter model provides compile-time type safety and runtime validation.

### Alternative 3: Plugin System

Implement a separate plugin system with lifecycle hooks, distinct from the adapter registry.

**Rejected because:** This introduces unnecessary conceptual overhead. The adapter registry already provides registration, discovery, and factory resolution. Infrastructure concerns fit naturally into this model without inventing new abstractions.

---

## Implementation Plan

- [x] Update JSON Schema (`adapter-binding.schema.json`)
- [x] Extend `AdapterInterface` union type in reference implementation
- [x] Add `SecretStore`, `MemoryStore`, `EventBus` interface definitions
- [x] Enhance `AuditSink` interface with optional methods
- [x] Extend `AdapterInterfaces` map
- [x] Create stub implementations (one per interface)
- [x] Register infrastructure adapters in adapter registry
- [x] Update spec prose (`adapters.md`, `spec.md`, `glossary.md`)
- [x] Add conformance test fixtures
- [x] Wire dogfood pipeline to use adapter-resolved infrastructure
- [ ] Unit and integration tests

## Open Questions

1. **Should `MemoryStore` support transactions?** The current key-value interface is intentionally simple. Backends like Redis and DynamoDB support atomic operations, but adding transactions increases interface complexity. The proposal starts simple; a future RFC could add optional transaction support.

2. **Should `EventBus` support message acknowledgment?** Cloud pub/sub systems (SQS, Cloud Pub/Sub) support at-least-once delivery with ack/nack. The current fire-and-forget interface is simpler but may lose events. The proposal starts with at-most-once delivery; a future RFC could add delivery guarantees.

3. **Should `SecretStore` support secret versioning?** Vault and AWS Secrets Manager support versioned secrets. The current interface returns the latest version. Adding version support would complicate the interface but enable secret rotation workflows.

## References

- [spec.md §5.5 AdapterBinding](../spec.md#55-adapterbinding) — Current AdapterBinding resource definition
- [adapters.md](../adapters.md) — Adapter interface contracts and registration
- [PRD §9](../../research/ai-sdlc-framework-prd.md) — Adapter layer requirements
- [PRD §13](../../research/ai-sdlc-framework-prd.md) — Agent memory model
- [PRD §15](../../research/ai-sdlc-framework-prd.md) — Security model (sandboxing, secrets, audit)
- [Terraform Provider Model](https://developer.hashicorp.com/terraform/plugin) — Prior art for pluggable infrastructure providers
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) — Prior art for pluggable exporters and receivers
