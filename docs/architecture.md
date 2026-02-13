# Architecture

Technical architecture of the AI-SDLC Framework reference implementation.

## Package Structure

The repository is a pnpm monorepo with three packages:

```
ai-sdlc/
├── spec/                    # Normative specification
│   ├── spec.md              # Main spec document
│   ├── policy.md            # Policy enforcement spec
│   ├── adapters.md          # Adapter layer spec
│   ├── agents.md            # Agent orchestration spec
│   ├── autonomy.md          # Progressive autonomy spec
│   ├── glossary.md          # Term definitions
│   ├── primer.md            # Conceptual introduction
│   └── schemas/             # JSON Schema (draft 2020-12) definitions
│       ├── common.schema.json
│       ├── pipeline.schema.json
│       ├── agent-role.schema.json
│       ├── quality-gate.schema.json
│       ├── autonomy-policy.schema.json
│       └── adapter-binding.schema.json
├── reference/               # @ai-sdlc/reference — SDK implementation
│   └── src/
│       ├── core/            # Types, validation, provenance, comparison
│       ├── builders/        # Fluent resource builders
│       ├── policy/          # Enforcement, autonomy, authorization, admission
│       ├── adapters/        # Interface contracts, implementations, stubs
│       ├── agents/          # Orchestration, execution, memory, discovery
│       ├── reconciler/      # Controller loop, diff, resource reconcilers
│       ├── audit/           # Hash-chained audit log, file sink
│       ├── metrics/         # Metric store, standard metrics, instrumentation
│       ├── telemetry/       # OpenTelemetry tracing, structured logging
│       ├── security/        # Sandbox, JIT credentials, kill switch, approvals
│       └── compliance/      # Regulatory framework mappings, checker
├── conformance/             # Conformance test suite
│   └── runner/
│       └── src/             # Schema conformance + SDK integration tests
├── dogfood/                 # Self-hosted pipeline (eats own dog food)
│   └── src/
│       ├── orchestrator/    # Pipeline orchestration implementation
│       ├── runner/          # Stage execution
│       └── resources/       # YAML resource definitions
└── docs/                    # User-facing documentation (this directory)
```

## Data Flow

### Pipeline Execution

```
1. Trigger Event (e.g., issue.assigned)
        │
2. Pipeline Resolution
   ├── Load Pipeline resource
   ├── Resolve adapter bindings
   └── Determine routing strategy
        │
3. Complexity Scoring
   ├── Evaluate task complexity (1-10)
   └── Select routing strategy
        │
4. Stage Execution Loop
   │   For each stage:
   │   ├── Resolve AgentRole
   │   ├── Authorization check
   │   ├── Execute agent (via TaskFn)
   │   ├── Quality gate enforcement
   │   │   ├── Mutating gates (transform)
   │   │   ├── Metric rules
   │   │   ├── Tool rules
   │   │   ├── Reviewer rules
   │   │   └── Expression/LLM rules
   │   ├── Handoff validation
   │   └── Audit log recording
        │
5. Pipeline Complete
   └── Update status conditions
```

### Reconciliation Pattern

The reconciler implements a Kubernetes-style controller loop:

```
┌─────────┐     ┌─────────┐     ┌──────┐     ┌─────┐
│ Desired  │────▶│ Observe │────▶│ Diff │────▶│ Act │──┐
│  State   │     │  Actual │     │      │     │     │  │
└─────────┘     └─────────┘     └──────┘     └─────┘  │
     ▲                                                  │
     └──────────────────────────────────────────────────┘
                    Loop (level-triggered)
```

Properties:
- **Level-triggered** -- Reacts to current state differences, not edge events
- **Idempotent** -- Same input always produces the same output
- **Eventually consistent** -- Converges to desired state over time
- **Rate-limited** -- Exponential backoff with jitter on errors

### Admission Pipeline

Resources pass through a multi-stage admission pipeline before being accepted:

```
Resource ──▶ Authentication ──▶ Authorization ──▶ Mutation ──▶ Validation ──▶ Admitted
              (who?)            (allowed?)         (enrich)     (schema)
```

## Key Design Decisions

### Resource Envelope

All five resource types share the same envelope: `apiVersion`, `kind`, `metadata`, `spec`, `status`. This enables:
- Uniform validation logic
- Generic reconciliation loop
- Consistent metadata handling (labels, annotations, provenance)

### Three-Tier Enforcement

Quality gates use advisory/soft-mandatory/hard-mandatory inspired by HashiCorp Sentinel. This allows teams to introduce new policies gradually (start advisory, promote to mandatory).

### Adapter Interface Abstraction

Adapters implement standard interfaces (`IssueTracker`, `SourceControl`, etc.) so pipelines are decoupled from specific tools. Swapping Linear for Jira only requires changing the `AdapterBinding` resource -- no pipeline modifications.

### Hash-Chained Audit Log

Every action produces an immutable, hash-chained audit entry. Each entry's SHA-256 hash includes the previous entry's hash, making any tampering detectable via `verifyIntegrity()`.

### Progressive Autonomy

Trust is earned, not granted. Agents start at Level 0 (read-only) and must meet quantitative criteria plus human approval to advance. Demotion is immediate on security incidents. This provides a structured path from zero trust to high autonomy.

## Module Dependencies

```
core ◀─── builders
  ▲
  │
  ├──── policy ◀─── agents (executor uses AuthorizationHook)
  │       ▲
  │       │
  ├──── reconciler
  │
  ├──── audit
  │
  ├──── metrics
  │
  ├──── telemetry
  │
  ├──── security
  │
  ├──── compliance
  │
  └──── adapters ◀─── agents (memory uses MemoryStore)
```

The `core` module has zero internal dependencies. All other modules depend on `core` for types. Cross-module dependencies are minimal and always through interfaces.

## Technology Stack

| Component | Technology |
|---|---|
| Language | TypeScript 5.7+ |
| Runtime | Node.js 20+ |
| Package manager | pnpm 9+ |
| Schema validation | Ajv (JSON Schema draft 2020-12) |
| Tracing | OpenTelemetry API (no-op without SDK) |
| Testing | Vitest |
| Linting | ESLint |
| Formatting | Prettier |
