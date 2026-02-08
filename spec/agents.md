# AI-SDLC Agent Orchestration Specification

<!-- Source: PRD Sections 13, 15 -->

**Document type:** Normative
**Status:** Draft
**Spec version:** v1alpha1

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Agent Role Schema](#2-agent-role-schema)
3. [Orchestration Patterns](#3-orchestration-patterns)
4. [Handoff Contracts](#4-handoff-contracts)
5. [Agent State Management](#5-agent-state-management)
6. [Agent Discovery](#6-agent-discovery)
7. [Security](#7-security)

---

## 1. Introduction

This document specifies how AI agents are defined, discovered, and orchestrated within the AI-SDLC Framework. Agent roles are declared as [AgentRole](spec.md#52-agentrole) resources using the [Role-Goal-Backstory](glossary.md#role-goal-backstory) pattern. Agents communicate through typed [handoff contracts](glossary.md#handoff-contract), discover each other via A2A-compatible [Agent Cards](glossary.md#agent-card), and coordinate using one of five orchestration patterns.

---

## 2. Agent Role Schema

<!-- Source: PRD Section 13 -->

### 2.1 The Role-Goal-Backstory Pattern

Every [AgentRole](spec.md#52-agentrole) resource defines an agent's identity using three fields:

- **`role`** (REQUIRED) — The agent's role title. Implementations SHOULD use this as the agent's primary identity in logs, notifications, and audit trails.
- **`goal`** (REQUIRED) — What the agent aims to achieve. This SHOULD be a clear, measurable objective that guides the agent's behavior.
- **`backstory`** (OPTIONAL) — Context for the agent's persona and expertise. This provides additional context for LLM-based agents to inform their behavior.

### 2.2 Tools

The `tools` array declares which tools the agent is permitted to use. Implementations MUST enforce tool restrictions — an agent MUST NOT invoke tools not listed in its `tools` array.

Tool identifiers are implementation-defined strings. Common tools include:
- `code_editor` — Read and write source code files
- `terminal` — Execute shell commands
- `git_client` — Git operations (branch, commit, push)
- `test_runner` — Execute test suites
- `browser` — Browse web pages
- `file_search` — Search file contents

### 2.3 Constraints

Constraints define operational limits that implementations MUST enforce:

- **`maxFilesPerChange`** — When set, implementations MUST reject changes that modify more than this number of files.
- **`requireTests`** — When `true`, implementations MUST verify that code changes include corresponding tests.
- **`allowedLanguages`** — When set, implementations MUST reject code generation in languages not listed.
- **`blockedPaths`** — Implementations MUST prevent the agent from modifying files matching any of these glob patterns.

---

## 3. Orchestration Patterns

<!-- Source: PRD Section 13.1 -->

The framework supports five orchestration patterns for multi-agent workflows. The pattern is selected based on the task requirements and declared in the [Pipeline](spec.md#51-pipeline) resource's stage configuration.

### 3.1 Sequential

Agents execute in series. The output of one agent becomes the input of the next.

```
implement → review → deploy
```

**Characteristics:**
- Deterministic execution order
- Each stage completes before the next begins
- Simplest pattern to reason about and debug

**Use cases:** Standard feature delivery, linear approval workflows.

### 3.2 Parallel

Multiple agents work simultaneously on related sub-tasks. Outputs are combined after all agents complete.

```
         ┌─→ code-agent ──┐
trigger ─┤                  ├─→ combine → review
         └─→ test-agent ──┘
```

**Characteristics:**
- Agents operate independently on the same or related inputs
- A synchronization barrier waits for all agents to complete
- Research shows 30-40% error reduction on complex reasoning tasks

**Use cases:** Code and tests in parallel, multi-file generation, parallel review.

### 3.3 Hierarchical

A supervisor agent decomposes a complex task and delegates sub-tasks to worker agents.

```
supervisor
  ├─→ agent-a (sub-task 1)
  ├─→ agent-b (sub-task 2)
  └─→ agent-c (sub-task 3)
```

**Characteristics:**
- Single point of coordination
- Supervisor handles task decomposition and result aggregation
- Risk of bottleneck at the supervisor

**Use cases:** Complex feature breakdown, large refactoring with multiple domains.

### 3.4 Swarm

Semi-autonomous agents with local coordination rules. Agents discover tasks and coordinate without a central supervisor.

**Characteristics:**
- No single point of coordination
- Agents use shared state for coordination
- Emergent behavior from local rules

**Use cases:** Large-scale codebase migrations, distributed refactoring.

### 3.5 Hybrid

Combines multiple patterns. Most production systems use hybrid orchestration.

```
supervisor (hierarchical)
  ├─→ parallel: [code-agent, test-agent]
  └─→ sequential: review-agent → deploy-agent
```

**Characteristics:**
- Hierarchical planning with parallel execution
- Structured handoffs between phases
- Adapts pattern to sub-task requirements

**Use cases:** Most production SDLC workflows.

---

## 4. Handoff Contracts

<!-- Source: PRD Section 13.2 -->

Inter-agent transfers MUST be treated as versioned API contracts. Every agent transition MUST produce a typed, validated, auditable artifact conforming to its [handoff contract](glossary.md#handoff-contract).

### 4.1 Contract Structure

A handoff contract is a JSON Schema document defining the data structure for an inter-agent transition:

```yaml
handoffContract:
  id: "impl-to-review-v1"
  version: "1.0.0"
  schema:
    type: object
    required: [prUrl, testResults, coverageReport, changeSummary]
    properties:
      prUrl:
        type: string
        format: uri
      testResults:
        type: object
        properties:
          passed: { type: integer }
          failed: { type: integer }
          skipped: { type: integer }
      coverageReport:
        type: object
        properties:
          lineCoverage: { type: number, minimum: 0, maximum: 100 }
      changeSummary:
        type: string
        maxLength: 5000
```

### 4.2 Validation

Implementations MUST validate handoff payloads against their contract schema before accepting the handoff. Invalid payloads MUST be rejected with an error indicating which fields failed validation.

### 4.3 Versioning

Handoff contracts MUST be versioned. The version is declared in the contract's `version` field. When a contract changes:

- Adding optional fields is a backward-compatible change (minor version bump)
- Adding required fields is a breaking change (major version bump)
- Removing fields is a breaking change (major version bump)

Agents MUST declare which contract version they produce (in `handoffs[].contract.schema`) and implementations SHOULD verify compatibility between producers and consumers.

### 4.4 Auditability

Every handoff event MUST be recorded in the audit trail with:
- Source agent identity
- Target agent identity
- Contract ID and version
- Handoff payload (or reference to stored payload)
- Timestamp
- Validation result (pass/fail)

---

## 5. Agent State Management

<!-- Source: PRD Section 13.3 -->

The framework defines standard interfaces for multi-tier agent memory. Implementations SHOULD support all five tiers.

### 5.1 Memory Tiers

| Tier | Scope | Persistence | Use |
| --- | --- | --- | --- |
| **Working Memory** | Current context window | Ephemeral | Active task execution |
| **Short-Term Memory** | Within session | Session-scoped | Multi-step task context |
| **Long-Term Memory** | Across sessions | Persistent store | Learning, preferences, patterns |
| **Shared Memory** | Multi-agent | Distributed store | Coordination, shared context |
| **Episodic Memory** | Historical events | Append-only log | Audit trail, experience replay |

### 5.2 Working Memory

The current context available to the agent during task execution. This is typically the LLM's context window. Implementations SHOULD manage context window utilization to prevent degradation.

### 5.3 Short-Term Memory

State maintained within a single session or task execution. This enables multi-step tasks where the agent needs to reference earlier steps. Implementations SHOULD provide checkpoint and resume capabilities.

### 5.4 Long-Term Memory

Persistent state across sessions. This enables agents to learn from experience and maintain preferences. Long-term memory MUST be scoped to the agent's [namespace](glossary.md#namespace) and MUST NOT leak information across namespaces.

### 5.5 Shared Memory

State shared between multiple agents for coordination. Implementations MUST ensure consistency and prevent race conditions when multiple agents read and write shared state concurrently.

### 5.6 Episodic Memory

An append-only log of historical events. Episodic memory serves both as an audit trail and as a source for experience replay during agent improvement. Episodic memory MUST be immutable — entries MUST NOT be modified or deleted.

---

## 6. Agent Discovery

<!-- Source: PRD Section 13.4 -->

Agents SHOULD publish [A2A](glossary.md#a2a)-compatible [Agent Cards](glossary.md#agent-card) at `/.well-known/agent.json`, enabling dynamic discovery of capabilities.

### 6.1 Agent Card Format

An Agent Card MUST include:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | MUST | Agent display name. |
| `description` | string | MUST | Agent description. |
| `endpoint` | string (URI) | MUST | Agent service endpoint. |
| `version` | string | MUST | Agent card version. |
| `skills` | array[Skill] | SHOULD | Declared capabilities. |
| `securitySchemes` | array[string] | SHOULD | Supported authentication methods. |

### 6.2 Skill Declaration

Each [skill](glossary.md#skill) in an Agent Card represents a discrete capability:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | MUST | Unique skill identifier. |
| `description` | string | MUST | Human-readable description. |
| `tags` | array[string] | SHOULD | Categorization tags. |
| `examples` | array[SkillExample] | MAY | Input/output examples. |

### 6.3 Discovery Mechanisms

Implementations SHOULD support discovering agents through:

1. **Well-known endpoint** — HTTP GET to `/.well-known/agent.json`
2. **Resource registry** — Query [AgentRole](spec.md#52-agentrole) resources in the cluster
3. **Service mesh** — DNS-based discovery for agents deployed as services

---

## 7. Security

<!-- Source: PRD Section 15 -->

### 7.1 Identity and Access Control

Traditional RBAC is insufficient for AI agents because their roles change based on task context and [autonomy level](glossary.md#autonomy-level). Implementations MUST support:

- **Dynamic role assignment** — Permissions adjusting based on task context and autonomy level
- **ABAC (Attribute-Based Access Control)** — Evaluating user, resource, environment, and action attributes
- **Just-in-time access** — Short-lived credentials scoped to specific tasks
- **Policy-based authorization** — External authorization service vetting every tool invocation

### 7.2 Three-Layer Defense-in-Depth

Implementations SHOULD implement defense-in-depth across three layers:

| Layer | Controls |
| --- | --- |
| **Environment** | Sandboxing (Firecracker, gVisor, hardened containers), network segmentation, read-only source mirrors |
| **Permissions** | Scoped tokens, time-boxed credentials, file-tree allowlists, policy enforcers gating every action |
| **Runtime Enforcement** | Real-time monitoring, human approval for risky diffs, git hooks, CI gates, kill switches |

### 7.3 Risk-Tiered Approval Workflows

Actions SHOULD be classified into risk tiers with corresponding approval requirements:

| Tier | Scope | Approval |
| --- | --- | --- |
| **Tier 1** | Documentation, tests, simple config | Automated gates only |
| **Tier 2** | Feature code, bug fixes | Automated gates + single human reviewer |
| **Tier 3** | Cross-service changes, API modifications | Multiple reviewers including domain expert |
| **Tier 4** | Security-critical, authentication code | Architecture review board; AI generation may be prohibited |

### 7.4 Audit Trail

Every action MUST produce an immutable, tamper-evident audit log entry including:

- Actor identity (human or agent)
- Action type
- Resource affected
- Policy evaluated
- Decision rendered
- Timestamp
- Autonomy level at time of action

Audit log entries MUST NOT be modifiable after creation. Implementations SHOULD use append-only storage with integrity verification.
