# AI-SDLC Framework Glossary

<!-- Source: PRD Section 21, expanded -->

**Document type:** Informative
**Status:** Draft
**Spec version:** v1alpha1

---

This document defines terms used throughout the AI-SDLC Framework specification. Terms are listed alphabetically. Cross-references to normative sections are provided where applicable.

## Terms

### A2A (Agent-to-Agent Protocol) {#a2a}

A protocol for inter-agent communication, task delegation, and capability discovery, originally developed by Google and governed under the Linux Foundation's AAIF. AI-SDLC agents publish A2A-compatible [Agent Cards](#agent-card) for discovery. See [agents.md](agents.md#agent-discovery).

### Adapter {#adapter}

A standalone module implementing one or more [interface contracts](#interface-contract) for a specific tool. For example, a Linear adapter implements the [IssueTracker](#interface-contract) interface. Adapters are registered via `metadata.yaml` and discovered from a registry, local directory, or git reference. See [adapters.md](adapters.md).

### Adapter Binding {#adapter-binding}

A [resource](#resource) of kind `AdapterBinding` that declares a tool integration as a swappable provider behind a uniform [interface contract](#interface-contract). See [spec.md](spec.md#55-adapterbinding).

### Agent Memory {#agent-memory}

The five-tier memory model for AI agents: working (ephemeral), short-term (TTL-based), long-term (persistent), shared (cross-agent), and episodic (append-only event history). The storage backend is abstracted by the [MemoryStore](#memory-store) infrastructure adapter. See [agents.md](agents.md).

### Agent Card {#agent-card}

An A2A-compatible discovery document published at `/.well-known/agent.json` describing an agent's name, capabilities, [skills](#skill), version, and security schemes. See [agents.md](agents.md#agent-discovery).

### Agent Role {#agent-role}

A [resource](#resource) of kind `AgentRole` that declares an AI agent's identity, capabilities, constraints, and [handoff](#handoff-contract) behavior using the [Role-Goal-Backstory](#role-goal-backstory) pattern. See [spec.md](spec.md#52-agentrole).

### Approval Policy {#approval-policy}

A stage-level configuration that specifies approval requirements before a [Pipeline](#pipeline) stage may execute. Approval policies declare whether approval is required, the approval tier, blocking behavior, timeout duration, and the action to take on timeout. See [spec.md](spec.md#approval-policy-object).

### Annotation {#annotation}

A key-value pair in a resource's [metadata](#metadata) used for non-identifying information such as build provenance, tooling hints, or operational notes. Annotations are not used for selection or filtering. See [spec.md](spec.md#3-metadata-object).

### Autonomy Level {#autonomy-level}

A numbered tier (0-3) defining the permissions, guardrails, and monitoring intensity for an AI agent. Level 0 (Observer) is read-only; Level 3 (Principal) is autonomous within domain. See [autonomy.md](autonomy.md).

### Autonomy Policy {#autonomy-policy}

A [resource](#resource) of kind `AutonomyPolicy` that declares progressive [autonomy levels](#autonomy-level) with quantitative [promotion criteria](#promotion) and automatic [demotion triggers](#demotion). See [spec.md](spec.md#54-autonomypolicy).

### Budget Policy {#budget-policy}

A [Pipeline](#pipeline)-level configuration that declares rolling budget constraints (period, amount, alerts) for cost governance. See RFC-0004.

### Budget Pressure {#budget-pressure}

A [model selection](#model-selection) mechanism that automatically routes agents to cheaper models as budget consumption increases. See RFC-0004.

### Branching Config {#branching-config}

A [Pipeline](#pipeline)-level configuration that declares branch naming patterns, target branches, and cleanup policy for feature branches created during pipeline execution. See [spec.md](spec.md#branching-config-object).

### Circuit Breaker {#circuit-breaker}

A real-time cost monitoring loop that interrupts agent execution when a cost limit is reached. See RFC-0004.

### Complexity Score {#complexity-score}

A numeric value (1-10) assigned to a task that determines the minimum [autonomy level](#autonomy-level) and human involvement required. Used by the [routing](#routing-strategy) system to assign tasks to appropriate agents. See [autonomy.md](autonomy.md#complexity-based-task-routing).

### Condition {#condition}

A structured status entry in a resource's `status.conditions` array. Each condition has a `type`, `status` (True, False, or Unknown), `reason`, and timestamps. Conditions represent individual aspects of a resource's observed state. See [spec.md](spec.md#5-conditions).

### Credential Policy {#credential-policy}

A stage-level configuration that specifies JIT (just-in-time) credential scope, time-to-live, and revocation behavior for a [Pipeline](#pipeline) stage. Credentials are scoped to the minimum permissions needed and automatically revoked on stage completion. See [spec.md](spec.md#credential-policy-object).

### Cost Attribution {#cost-attribution}

The process of tracking costs across dimensions (agent, model, stage, repository, complexity, team) for chargeback and analysis. See RFC-0004.

### Cost Policy {#cost-policy}

An optional [Pipeline](#pipeline)-level configuration that declares cost boundaries at per-execution, per-stage, and budget levels. See RFC-0004.

### Cost Receipt {#cost-receipt}

An extension to [provenance](#provenance) metadata that records the total cost breakdown (token cost, cache savings, compute, human review) for an AI-generated artifact. See RFC-0004.

### Conformance Level {#conformance-level}

One of three tiers (Core, Adapter, Full) defining the scope of specification compliance an implementation achieves. See [spec.md](spec.md#11-conformance-levels).

### Demotion {#demotion}

Automatic reduction of an agent's [autonomy level](#autonomy-level) triggered by a policy violation such as a security incident, excessive rollback rate, or unauthorized access attempt. Demotions include a cooldown period before re-promotion is possible. See [autonomy.md](autonomy.md#demotion-triggers).

### Failure Policy {#failure-policy}

A stage-level configuration that defines how a [Pipeline](#pipeline) handles stage failures. Strategies include `abort` (stop the pipeline), `retry` (re-execute up to a limit), `pause` (suspend for manual intervention), and `continue` (proceed to the next stage). See [spec.md](spec.md#failure-policy-object).

### EventBus {#event-bus}

An [infrastructure adapter](#infrastructure-adapter) interface for event publication and subscription. Abstracts the event delivery mechanism (e.g., in-process `EventEmitter`, NATS, Kafka, cloud pub/sub) behind a topic-based publish/subscribe API. See [adapters.md](adapters.md#35-eventbus).

### Enforcement Level {#enforcement-level}

The strictness of a [quality gate](#quality-gate): `advisory` (warning only), `soft-mandatory` (must pass unless overridden), or `hard-mandatory` (must pass, no override). See [policy.md](policy.md#enforcement-levels).

### Handoff Contract {#handoff-contract}

A versioned JSON Schema defining the required data structure for inter-agent transitions. Every agent transition produces a typed, validated, auditable artifact conforming to its handoff contract. See [agents.md](agents.md#handoff-contracts).

### Infrastructure Adapter {#infrastructure-adapter}

An [adapter](#adapter) that abstracts a runtime infrastructure concern (audit storage, sandboxing, secret management, memory persistence, event delivery) rather than an external SDLC tool. Infrastructure adapters use the same `AdapterBinding` resource model as SDLC adapters. The five infrastructure interfaces are: [AuditSink](adapters.md#31-auditsink), [Sandbox](adapters.md#32-sandbox), [SecretStore](#secret-store), [MemoryStore](#memory-store), [EventBus](#event-bus). See [adapters.md](adapters.md#3-infrastructure-adapters).

### Interface Contract {#interface-contract}

A typed API definition for an integration category. SDLC interfaces: IssueTracker, SourceControl, CIPipeline, CodeAnalysis, Messenger, DeploymentTarget. Infrastructure interfaces: AuditSink, Sandbox, SecretStore, MemoryStore, EventBus. Each [adapter](#adapter) implements one or more interface contracts. See [adapters.md](adapters.md#2-interface-contracts).

### Label {#label}

A key-value pair in a resource's [metadata](#metadata) used for identification, selection, and filtering. Labels enable resource queries and policy targeting. See [spec.md](spec.md#3-metadata-object).

### Model Selection {#model-selection}

An [AgentRole](#agent-role)-level configuration that routes tasks to different models based on [complexity score](#complexity-score) and [budget pressure](#budget-pressure). See RFC-0004.

### MCP (Model Context Protocol) {#mcp}

A protocol for connecting AI agents to external tools and data sources, originally developed by Anthropic and governed under the Linux Foundation's AAIF. AI-SDLC [adapters](#adapter) can wrap MCP servers. See [adapters.md](adapters.md).

### MemoryStore {#memory-store}

An [infrastructure adapter](#infrastructure-adapter) interface providing a key-value persistence backend for the five-tier [agent memory](#agent-memory) model. Abstracts the storage mechanism (e.g., JSON files, Redis, DynamoDB) behind a simple read/write/delete/list API. See [adapters.md](adapters.md#34-memorystore).

### Metadata {#metadata}

The `metadata` object present on every [resource](#resource), containing `name`, `namespace`, [labels](#label), and [annotations](#annotation). See [spec.md](spec.md#3-metadata-object).

### Notification Template {#notification-template}

A templated message for [Pipeline](#pipeline) events such as gate failures, agent errors, or PR creation. Templates specify a target (`issue`, `pr`, or `both`), a title, and an optional body with placeholder variables. See [spec.md](spec.md#notification-template-object).

### Namespace {#namespace}

A scoping unit within the [metadata](#metadata) of a [resource](#resource), typically corresponding to a team or project. Resource names must be unique within a namespace.

### Priority Policy {#priority-policy}

An optional [Pipeline](#pipeline)-level configuration that enables the Product Priority Algorithm (PPA) for autonomous work item prioritization. Declares minimum score/confidence thresholds, soul purpose statement, dimension configuration, calibration settings, and adapter references for external signal ingestion. See RFC-0005.

### Priority Score {#priority-score}

A composite numeric value produced by the Product Priority Algorithm (PPA). Computed as the multiplicative product of seven dimensions: Soul Alignment (Sα), Demand Pressure (Dπ), Market Force (Mφ), Execution Reality (Eρ), Entropy Tax (Eτ), Human Curve (HC), and Calibration (Cκ). A zero in any dimension vetoes the work item. See RFC-0005.

### Pipeline {#pipeline}

A [resource](#resource) of kind `Pipeline` that defines a complete SDLC workflow from trigger through delivery, including stages, agent assignments, [quality gates](#quality-gate), and [routing](#routing-strategy) rules. See [spec.md](spec.md#51-pipeline).

### Promotion {#promotion}

Advancement of an agent's [autonomy level](#autonomy-level) after meeting quantitative criteria (minimum tasks, metric thresholds) and receiving explicit approval from designated roles. See [autonomy.md](autonomy.md#promotion-criteria).

### Pull Request Config {#pull-request-config}

A [Pipeline](#pipeline)-level configuration that declares conventions for pull request creation, including title templates, description sections, [provenance](#provenance) inclusion, and issue-closing keywords. See [spec.md](spec.md#pull-request-config-object).

### Provenance {#provenance}

The recorded origin of an AI-generated artifact, including model identifier, tool, prompt hash, timestamp, human reviewer identity, and review decision. See [metrics.md](metrics.md#provenance-tracking).

### Quality Gate {#quality-gate}

A [resource](#resource) of kind `QualityGate` that defines a policy rule evaluated against development activity with a defined [enforcement level](#enforcement-level). See [spec.md](spec.md#53-qualitygate).

### Reconciliation Loop {#reconciliation-loop}

The continuous process of observing current state, diffing against desired state, and acting to close the gap. The reconciliation loop is the runtime heart of the AI-SDLC Framework, following the Kubernetes controller pattern. See [spec.md](spec.md#9-reconciliation-semantics).

### Resource {#resource}

A declarative object with five top-level fields: `apiVersion`, `kind`, [metadata](#metadata), `spec`, and `status`. All AI-SDLC configuration is expressed as resources. See [spec.md](spec.md#2-resource-model).

### Role-Goal-Backstory {#role-goal-backstory}

The pattern used by [AgentRole](#agent-role) resources to define an agent's identity. `role` is the agent's title, `goal` is what it aims to achieve, and `backstory` provides context for the agent's persona. Derived from the CrewAI framework. See [agents.md](agents.md#agent-role-schema).

### Routing Strategy {#routing-strategy}

The method by which tasks are assigned to agents based on [complexity score](#complexity-score). Four strategies are defined: `fully-autonomous`, `ai-with-review`, `ai-assisted`, and `human-led`. See [autonomy.md](autonomy.md#complexity-based-task-routing).

### SecretStore {#secret-store}

An [infrastructure adapter](#infrastructure-adapter) interface for secret resolution and management. Abstracts the secret storage mechanism (e.g., environment variables, HashiCorp Vault, AWS Secrets Manager) behind a get/set API. See [adapters.md](adapters.md#33-secretstore).

### Secret Reference {#secret-reference}

A `secretRef` object used in resource specs to reference sensitive values (API keys, tokens) without embedding them directly. The referenced secret is resolved at runtime by the implementation. See [spec.md](spec.md#2-resource-model).

### Skill {#skill}

A declared capability of an [Agent Role](#agent-role) with an ID, description, tags, and examples. Skills enable [Agent Card](#agent-card) discovery and task routing. See [agents.md](agents.md#agent-role-schema).

### Spec/Status Split {#spec-status-split}

The separation of user intent (`spec`) from system-observed reality (`status`) in every [resource](#resource). `spec` represents desired state; `status` represents what the system observes. Controllers continuously reconcile the gap. See [spec.md](spec.md#4-the-specstatus-split).

### Transaction Limit {#transaction-limit}

A guardrail field in [AutonomyPolicy](#autonomy-policy) that specifies maximum cost per time period. See autonomy-policy.schema.json.
