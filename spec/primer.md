# AI-SDLC Framework Primer

<!-- Source: PRD Sections 1-5, 19 -->

**Document type:** Informative
**Status:** Draft
**Spec version:** v1alpha1

---

## Table of Contents

1. [What is the AI-SDLC Framework?](#1-what-is-the-ai-sdlc-framework)
2. [The Problem Space](#2-the-problem-space)
3. [Vision and Positioning](#3-vision-and-positioning)
4. [Design Principles](#4-design-principles)
5. [Architecture Overview](#5-architecture-overview)
6. [Resource Model Walkthrough](#6-resource-model-walkthrough)
7. [Getting Started](#7-getting-started)
8. [Target Personas](#8-target-personas)
9. [Regulatory Context](#9-regulatory-context)

---

## 1. What is the AI-SDLC Framework?

The AI-SDLC Framework is an open, vendor-neutral governance specification for AI-augmented software development lifecycles. It defines how human engineers and AI coding agents collaborate across the full SDLC — from issue triage through code generation, review, testing, and deployment — with predictable, auditable, enterprise-grade outcomes.

Think of it as "Kubernetes for your development process": declare your desired SDLC state in YAML, and controllers continuously reconcile actual development activity toward that declared state.

The framework sits above the emerging agent standards stack:

- **MCP** (Model Context Protocol) handles agent-to-tool integration
- **A2A** (Agent-to-Agent Protocol) handles agent-to-agent communication
- **AGENTS.md** handles per-project agent instructions
- **AI-SDLC** is the orchestration and governance layer that composes these into a governed lifecycle

This primer is an informative document. For normative requirements, see the [core specification](spec.md) and related normative documents.

---

## 2. The Problem Space

### 2.1 The Governance Vacuum

85% of developers now use AI coding tools and 41% of GitHub code is AI-generated, yet only 1 in 5 companies has mature governance for AI agents. The $4 billion AI coding market has produced dozens of capable tools but zero standards for how humans and AI agents should collaborate across the SDLC.

### 2.2 What Breaks Without Governance

The consequences are quantified:

- **Security**: AI-generated code introduces security flaws in 45% of test cases (Veracode), with Java showing a 70%+ failure rate
- **Quality decline**: Refactoring dropped from 25% of changes (2021) to 10% (2024); copy/paste code rose from 8.3% to 12.3%; code churn jumped from 5.5% to 7.9% (GitClear, 211M lines analyzed)
- **Productivity paradox**: Experienced developers using AI tools are 19% slower on mature codebases, despite believing they are 20% faster — a 39-percentage-point perception gap (METR RCT)
- **Stability regression**: Every 25% increase in AI adoption correlates with a 7.2% drop in system stability (Google DORA 2024)
- **Review bottleneck**: PRs merged increased 98% and PR size increased 154%, but code review time increased 91% (Faros AI). Review capacity, not developer output, is now the limiting factor.

### 2.3 The Enterprise Gap

75% of tech leaders cite governance as their primary deployment challenge for AI agents. Specific unmet needs include:

- No standardized framework for AI-augmented SDLC governance
- No agent orchestration standard for enterprise pipelines
- No code attribution system for AI-generated vs. human-written code
- No cross-tool cost management dashboard
- No industry-wide metrics for AI agent reliability
- 66.4% of enterprise implementations now use multi-agent architectures with no standard governing interaction

---

## 3. Vision and Positioning

### 3.1 Vision

Provide the open, vendor-neutral governance specification that enables enterprises to adopt AI coding agents with the same confidence, auditability, and predictability they expect from their existing SDLC tooling.

### 3.2 Strategic Positioning

The AI-SDLC Framework is complementary, not competitive, with existing protocols:

| Protocol | Scope | Relationship to AI-SDLC |
| --- | --- | --- |
| **MCP** (Anthropic / AAIF) | Agent-to-tool integration | AI-SDLC adapters can wrap MCP servers |
| **A2A** (Google / AAIF) | Agent-to-agent communication | AI-SDLC agents publish A2A-compatible Agent Cards |
| **AGENTS.md** (OpenAI) | Per-project agent instructions | AI-SDLC policies generate AGENTS.md files |
| **AI-SDLC** | SDLC orchestration & governance | The orchestration layer above all three |

This mirrors how Kubernetes related to Docker and etcd — a higher-level orchestration layer that composes lower-level primitives into a governed system.

---

## 4. Design Principles

The framework is built on ten design principles derived from analysis of 20+ major open-source infrastructure projects and 6 multi-agent orchestration frameworks:

| # | Principle | Rationale | Precedent |
| --- | --- | --- | --- |
| DP-1 | Separate WHAT from HOW | Users declare desired state; controllers encode operational knowledge | Kubernetes spec/status split |
| DP-2 | Declarative over imperative | YAML-defined policies, not procedural scripts | Kubernetes, Terraform, ArgoCD |
| DP-3 | Spec and implementation in separate repositories | Enables independent evolution, multiple implementations | GraphQL, OpenTelemetry |
| DP-4 | Extensible from day one | Custom resource types for org-specific phases, gates, and roles | Kubernetes CRDs |
| DP-5 | Tool-agnostic via adapters | Swap Linear for Jira, GitHub for GitLab, without changing pipeline definitions | Terraform providers, OTel Collector |
| DP-6 | Progressive enforcement | Start advisory, graduate to soft-mandatory, then hard-mandatory | HashiCorp Sentinel, OPA/Gatekeeper |
| DP-7 | Earned autonomy, not granted | Every agent starts at minimum autonomy; promotion requires quantitative evidence | CSA ATF, Knight-Columbia |
| DP-8 | Reconciliation over point-in-time checks | Continuous convergence toward declared state, not one-shot validation | Kubernetes controllers, ArgoCD, Flux |
| DP-9 | Core-plus-extensions model | Minimal required core; rich extension mechanism | CloudEvents |
| DP-10 | Compliance by design | Map lifecycle phases and controls to ISO 42001, NIST AI RMF, EU AI Act | OWASP ASI, CSA ATF |

---

## 5. Architecture Overview

The framework is organized into four layers, following OpenTelemetry's separation pattern:

```
┌─────────────────────────────────────────────────────────────────┐
│                      SPECIFICATION LAYER                        │
│  Resource types (Pipeline, AgentRole, QualityGate,              │
│  AutonomyPolicy, AdapterBinding) with JSON Schema validation    │
│  Version: v1alpha1 → v1beta1 → v1                              │
├─────────────────────────────────────────────────────────────────┤
│                        ADAPTER LAYER                            │
│  Terraform-style provider contracts per integration category    │
│  IssueTracker | SourceControl | CIPipeline | CodeAnalysis |    │
│  Messenger | DeploymentTarget                                   │
├─────────────────────────────────────────────────────────────────┤
│                        POLICY LAYER                             │
│  OPA/Gatekeeper template/instance separation                    │
│  Sentinel 3-tier enforcement (advisory|soft-mandatory|hard)     │
│  CSA ATF progressive autonomy levels                            │
├─────────────────────────────────────────────────────────────────┤
│                        RUNTIME LAYER                            │
│  Kubernetes controller reconciliation loop                      │
│  Declarative agent roles | Workflow graphs                      │
│  A2A-compatible Agent Cards for inter-service discovery         │
└─────────────────────────────────────────────────────────────────┘
         ▼               ▼                ▼              ▼
    ┌─────────┐   ┌──────────┐   ┌────────────┐   ┌──────────┐
    │  Linear  │   │  GitHub  │   │  SonarQube │   │  Slack   │
    │  Jira    │   │  GitLab  │   │  Semgrep   │   │  Teams   │
    └─────────┘   └──────────┘   └────────────┘   └──────────┘
```

### Layer 1: Specification Layer

Defines the five core [resource](glossary.md#resource) types that express all SDLC configuration declaratively. Each resource follows the [spec/status split](glossary.md#spec-status-split) pattern and is validated against a JSON Schema.

### Layer 2: Adapter Layer

Provides tool-agnostic integration through typed [interface contracts](glossary.md#interface-contract). Swapping one tool for another (e.g., Linear for Jira) requires changing only one field in the adapter binding — pipeline definitions remain unchanged. See [adapters.md](adapters.md).

### Layer 3: Policy Layer

Enforces quality gates with three graduated [enforcement levels](glossary.md#enforcement-level): advisory (warn), soft-mandatory (block with override), and hard-mandatory (block, no override). See [policy.md](policy.md).

### Layer 4: Runtime Layer

The [reconciliation loop](glossary.md#reconciliation-loop) continuously observes development activity, diffs against declared policies, and acts to close gaps. This transforms governance from point-in-time checks into continuous convergence. See [spec.md](spec.md#9-reconciliation-semantics).

---

## 6. Resource Model Walkthrough

Every AI-SDLC resource carries five top-level fields:

```yaml
apiVersion: ai-sdlc.io/v1alpha1     # Version travels with the data
kind: Pipeline                        # Resource type
metadata:
  name: feature-delivery              # Unique within namespace
  namespace: team-alpha               # Scoping unit
  labels:                             # Selection and filtering
    team: alpha
    environment: production
spec:                                 # DESIRED STATE (user writes)
  # ... what you want
status:                               # OBSERVED STATE (system writes)
  # ... what the system sees
```

The five core resource types:

- **[Pipeline](spec.md#51-pipeline)** — A complete SDLC workflow: triggers, providers (tools), stages (what to do), and routing (who does it based on complexity)
- **[AgentRole](spec.md#52-agentrole)** — An AI agent's identity (role, goal, backstory), tools, constraints, handoff contracts, and discovery info
- **[QualityGate](spec.md#53-qualitygate)** — Policy rules with scope targeting, graduated enforcement, and evaluation configuration
- **[AutonomyPolicy](spec.md#54-autonomypolicy)** — Progressive autonomy levels with permissions, guardrails, promotion criteria, and demotion triggers
- **[AdapterBinding](spec.md#55-adapterbinding)** — A tool integration declaring which interface it implements, its configuration, and health check settings

---

## 7. Getting Started

This section walks through a minimal adoption path, progressively adding governance capabilities.

### Step 1: Define a Minimal Pipeline

Start with a simple pipeline that triggers on issue assignment and routes through implement, review, and deploy stages:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: basic-delivery
  namespace: my-team
spec:
  triggers:
    - event: issue.assigned
      filter: { labels: ["ai-eligible"] }
  providers:
    sourceControl:
      type: github
      config: { org: "my-org" }
  stages:
    - name: implement
      agent: code-agent
    - name: review
      qualityGates: [basic-review]
    - name: deploy
```

### Step 2: Add Quality Gates

Add quality gates to enforce standards on AI-generated code:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: basic-review
  namespace: my-team
spec:
  gates:
    - name: test-coverage
      enforcement: advisory          # Start with advisory
      rule:
        metric: line-coverage
        operator: ">="
        threshold: 70
    - name: human-review
      enforcement: hard-mandatory
      rule:
        minimumReviewers: 1
```

Start with `advisory` enforcement to understand impact, then graduate to `soft-mandatory` and `hard-mandatory` as confidence grows.

### Step 3: Add Agent Roles

Define the agents that will execute pipeline stages:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: code-agent
  namespace: my-team
spec:
  role: "Software Engineer"
  goal: "Implement features with tested code"
  tools: [code_editor, terminal, test_runner]
  constraints:
    maxFilesPerChange: 10
    requireTests: true
```

### Step 4: Configure Autonomy

Add an autonomy policy to govern how agents earn trust:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AutonomyPolicy
metadata:
  name: team-policy
  namespace: my-team
spec:
  levels:
    - level: 1
      name: "Junior"
      permissions:
        read: ["*"]
        write: ["draft-pr", "comment"]
        execute: ["test-suite"]
      guardrails:
        requireApproval: all
      monitoring: continuous
      minimumDuration: "4w"
  promotionCriteria:
    "1-to-2":
      minimumTasks: 50
      conditions:
        - metric: pr-approval-rate
          operator: ">="
          threshold: 0.90
      requiredApprovals: [engineering-manager]
  demotionTriggers:
    - trigger: critical-security-incident
      action: demote-to-0
      cooldown: "4w"
```

---

## 8. Target Personas

| Persona | Role | Primary Needs |
| --- | --- | --- |
| **Platform Engineer** | Builds internal developer platform | Declarative policy definitions, adapter configuration, reconciliation dashboards |
| **Engineering Manager** | Owns team delivery and quality | Autonomy level controls, quality gate configuration, team-level metrics |
| **Security / Compliance Lead** | Enforces security and regulatory compliance | Hard-mandatory gates, audit trails, provenance tracking, regulatory mapping |
| **AI/ML Engineer** | Builds AI agent integrations | Agent role definitions, handoff contracts, tool bindings |
| **Software Developer** | Writes and reviews code alongside AI agents | Transparent policy feedback, clear escalation paths, trust in AI output |

### The Emerging Role: The Agentic Engineer

Not a traditional coder but a strategic architect of intelligent delivery systems — fluent in feedback loops, agent behavior, and orchestration. This persona is the primary power-user of the AI-SDLC Framework.

---

## 9. Regulatory Context

The AI-SDLC Framework is designed to facilitate compliance with three major regulatory frameworks:

| Regulation | AI-SDLC Mapping |
| --- | --- |
| **EU AI Act** | Risk-tier classification maps to complexity-based routing; transparency requirements map to provenance tracking; high-risk system requirements map to quality gates and audit trails |
| **NIST AI RMF** | Govern → AutonomyPolicy; Map → Pipeline complexity routing; Measure → Metrics framework; Manage → Reconciliation engine + demotion triggers |
| **ISO/IEC 42001** | Plan → Pipeline spec; Do → Agent execution; Check → Quality gates + reconciliation; Act → Auto-remediation + demotion |

The framework also aligns with:

- **ISO/IEC/IEEE 12207:2017** — SDLC process architecture (verification, validation, configuration management, traceability)
- **OWASP ASI Top 10 (2026)** — Threat categories for agentic AI
- **CSA Agentic Trust Framework** — Zero Trust principles for AI agents
