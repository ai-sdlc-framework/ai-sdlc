# AI-SDLC Framework — Product Requirements Document

**Version:** 0.1.0-draft
**Date:** 2026-02-07
**Status:** Draft
**Author:** Dominique Legault
**License:** Apache 2.0

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Vision and Positioning](#3-vision-and-positioning)
4. [Target Users and Personas](#4-target-users-and-personas)
5. [Design Principles](#5-design-principles)
6. [Architecture Overview](#6-architecture-overview)
7. [Specification Layer](#7-specification-layer)
8. [Core Resource Types](#8-core-resource-types)
9. [Adapter Layer](#9-adapter-layer)
10. [Policy Layer](#10-policy-layer)
11. [Runtime Layer — The Reconciliation Engine](#11-runtime-layer--the-reconciliation-engine)
12. [Progressive Autonomy System](#12-progressive-autonomy-system)
13. [Multi-Agent Orchestration](#13-multi-agent-orchestration)
14. [Metrics and Observability](#14-metrics-and-observability)
15. [Enterprise Readiness](#15-enterprise-readiness)
16. [Repository Structure](#16-repository-structure)
17. [Versioning and Evolution Strategy](#17-versioning-and-evolution-strategy)
18. [Conformance and Certification](#18-conformance-and-certification)
19. [Regulatory Alignment](#19-regulatory-alignment)
20. [Launch Phasing](#20-launch-phasing)
21. [Glossary](#21-glossary)
22. [References](#22-references)

---

## 1. Executive Summary

The AI-SDLC Framework is an open-source, declarative governance specification for AI-augmented software development lifecycles. It defines how human engineers and AI coding agents collaborate across the full SDLC — from issue triage through code generation, review, testing, and deployment — with predictable, auditable, enterprise-grade outcomes.

The framework sits above the emerging agent standards stack (MCP for agent-to-tool, A2A for agent-to-agent, AGENTS.md for agent-to-project) as the missing **orchestration and governance layer** that composes these primitives into a governed development lifecycle.

The specification follows a Kubernetes-inspired declarative model: teams declare desired SDLC state in YAML (quality gates, autonomy levels, routing rules, cost budgets), adapters observe actual development activity, a reconciliation engine diffs declared policy against observed reality, and controllers act to close the gap — continuously.

---

## 2. Problem Statement

### 2.1 The Governance Vacuum

85% of developers now use AI coding tools and 41% of GitHub code is AI-generated, yet only 1 in 5 companies has mature governance for AI agents. The $4 billion AI coding market (2025) has produced dozens of capable tools but zero standards for how humans and AI agents should collaborate across the SDLC.

### 2.2 What Breaks Without Governance

The consequences of ungoverned AI coding are quantified and severe:

- **Security**: Veracode found AI-generated code introduced security flaws in 45% of test cases, with Java showing a 70%+ failure rate.
- **Quality Decline**: Refactoring dropped from 25% of changes (2021) to 10% (2024). Copy/paste code rose from 8.3% to 12.3%. Code churn jumped from 5.5% to 7.9%.
- **Productivity Paradox**: The METR RCT found experienced developers using AI tools were 19% slower on mature codebases, despite believing they were 20% faster — a 39-percentage-point perception gap.
- **Stability Regression**: Google's DORA 2024 report showed every 25% increase in AI adoption correlated with a 7.2% drop in system stability.
- **Review Bottleneck**: PRs merged increased 98% and PR size increased 154%, but code review time increased 91%. Review capacity, not developer output, is now the limiting factor.
- **Trust Erosion**: Stack Overflow's December 2025 survey recorded the first-ever decline in AI tool sentiment, with only 3% of developers expressing high trust in AI output.

### 2.3 The Enterprise Gap

75% of tech leaders cite governance as their primary deployment challenge for AI agents. Core unmet needs include:

- No standardized framework for AI-augmented SDLC governance
- No agent orchestration standard for enterprise pipelines
- No code attribution system for AI-generated vs. human-written code
- No cross-tool cost management dashboard
- No industry-wide metrics for AI agent reliability
- 66.4% of enterprise implementations now use multi-agent architectures with no standard governing interaction

---

## 3. Vision and Positioning

### 3.1 Vision Statement

Provide the open, vendor-neutral governance specification that enables enterprises to adopt AI coding agents with the same confidence, auditability, and predictability they expect from their existing SDLC tooling.

### 3.2 Strategic Positioning

The AI-SDLC Framework is **complementary, not competitive** with existing protocols:

| Protocol                   | Scope                           | Relationship to AI-SDLC                           |
| -------------------------- | ------------------------------- | ------------------------------------------------- |
| **MCP** (Anthropic / AAIF) | Agent-to-tool integration       | AI-SDLC adapters can wrap MCP servers             |
| **A2A** (Google / AAIF)    | Agent-to-agent communication    | AI-SDLC agents publish A2A-compatible Agent Cards |
| **AGENTS.md** (OpenAI)     | Per-project agent instructions  | AI-SDLC policies generate AGENTS.md files         |
| **AI-SDLC**                | SDLC orchestration & governance | The orchestration layer above all three           |

This mirrors how Kubernetes related to Docker and etcd — a higher-level orchestration layer that composes lower-level primitives into a governed system.

### 3.3 Design Analogy

> Declare desired SDLC state in YAML → Observe actual development activity via adapters → Diff against policy → Reconcile — continuously.

---

## 4. Target Users and Personas

### 4.1 Primary Personas

| Persona                        | Role                                                 | Needs from AI-SDLC                                                               |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Platform Engineer**          | Builds and maintains the internal developer platform | Declarative policy definitions, adapter configuration, reconciliation dashboards |
| **Engineering Manager**        | Owns team delivery and quality                       | Autonomy level controls, quality gate configuration, team-level metrics          |
| **Security / Compliance Lead** | Enforces security policy and regulatory compliance   | Hard-mandatory gates, audit trails, provenance tracking, regulatory mapping      |
| **AI/ML Engineer**             | Builds and tunes AI agent integrations               | Agent role definitions, handoff contracts, tool bindings                         |
| **Software Developer**         | Writes and reviews code alongside AI agents          | Transparent policy feedback, clear escalation paths, trust in AI output          |

### 4.2 The Emerging Role: The Agentic Engineer

Not a traditional coder but a strategic architect of intelligent delivery systems — fluent in feedback loops, agent behavior, and orchestration. This persona is the primary power-user of the AI-SDLC Framework.

---

## 5. Design Principles

These principles are derived from the analysis of 20+ major open-source infrastructure projects and 6 multi-agent orchestration frameworks.

| #         | Principle                                            | Rationale                                                                        | Precedent                                |
| --------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| **DP-1**  | **Separate WHAT from HOW**                           | Users declare desired lifecycle state; controllers encode operational knowledge  | Kubernetes spec/status split             |
| **DP-2**  | **Declarative over imperative**                      | YAML-defined policies, not procedural scripts                                    | Kubernetes, Terraform, ArgoCD            |
| **DP-3**  | **Spec and implementation in separate repositories** | Enables independent evolution, multiple implementations                          | GraphQL, OpenTelemetry                   |
| **DP-4**  | **Extensible from day one**                          | Custom resource types for org-specific phases, gates, and roles                  | Kubernetes CRDs                          |
| **DP-5**  | **Tool-agnostic via adapters**                       | Swap Linear for Jira, GitHub for GitLab, without changing pipeline definitions   | Terraform providers, OTel Collector      |
| **DP-6**  | **Progressive enforcement**                          | Start advisory, graduate to soft-mandatory, then hard-mandatory                  | HashiCorp Sentinel, OPA/Gatekeeper       |
| **DP-7**  | **Earned autonomy, not granted**                     | Every agent starts at minimum autonomy; promotion requires quantitative evidence | CSA ATF, Knight-Columbia, Least Autonomy |
| **DP-8**  | **Reconciliation over point-in-time checks**         | Continuous convergence toward declared state, not one-shot validation            | Kubernetes controllers, ArgoCD, Flux     |
| **DP-9**  | **Core-plus-extensions model**                       | Minimal required core; rich extension mechanism                                  | CloudEvents                              |
| **DP-10** | **Compliance by design**                             | Map lifecycle phases and controls to ISO 42001, NIST AI RMF, EU AI Act           | OWASP ASI, CSA ATF                       |

---

## 6. Architecture Overview

The framework is organized into four layers, following OpenTelemetry's proven separation pattern:

```
┌─────────────────────────────────────────────────────────────────┐
│                      SPECIFICATION LAYER                        │
│  Resource types (Pipeline, AgentRole, QualityGate,              │
│  AutonomyPolicy, AdapterBinding) with OpenAPI v3 schemas        │
│  Version: v1alpha1 → v1beta1 → v1                               │
├─────────────────────────────────────────────────────────────────┤
│                        ADAPTER LAYER                            │
│  Terraform-style provider contracts per integration category    │
│  IssueTracker | SourceControl | CIPipeline | CodeAnalysis |     │
│  Messenger | DeploymentTarget                                   │
├─────────────────────────────────────────────────────────────────┤
│                        POLICY LAYER                             │
│  OPA/Gatekeeper template/instance separation                    │
│  Sentinel 3-tier enforcement (advisory|soft-mandatory|hard)     │
│  CSA ATF progressive autonomy levels                            │
├─────────────────────────────────────────────────────────────────┤
│                        RUNTIME LAYER                            │
│  Kubernetes controller reconciliation loop                      │
│  CrewAI declarative agent roles | LangGraph workflow graphs     │
│  A2A-compatible Agent Cards for inter-service discovery         │
└─────────────────────────────────────────────────────────────────┘
         ▼               ▼                ▼              ▼
    ┌─────────┐   ┌──────────┐   ┌────────────┐   ┌──────────┐
    │  Linear │   │  GitHub  │   │  SonarQube │   │  Slack   │
    │  Jira   │   │  GitLab  │   │  Semgrep   │   │  Teams   │
    └─────────┘   └──────────┘   └────────────┘   └──────────┘
```

---

## 7. Specification Layer

### 7.1 Resource Model

Every AI-SDLC resource carries five top-level fields, following the Kubernetes canonical model:

```yaml
apiVersion: ai-sdlc.io/v1alpha1 # Embedded version (travels with the data)
kind: <ResourceType> # Pipeline | AgentRole | QualityGate | etc.
metadata:
  name: <unique-name> # Unique within namespace
  namespace: <team-or-project> # Scoping unit
  labels: {} # Arbitrary key-value for selection
  annotations: {} # Non-identifying metadata
spec: {} # Desired state (user intent)
status: {} # Observed state (system reality)
```

The **spec/status split** is the single most important structural decision. `spec` represents what the user wants; `status` represents what the system observes. Controllers continuously reconcile the gap.

### 7.2 Schema Validation

All resource types MUST define OpenAPI v3 schemas enabling:

- Server-side validation (reject invalid resources before admission)
- Field pruning (reject unknown fields)
- Default values
- Pattern matching and enum constraints
- IDE autocompletion and CI validation
- Programmatic tooling and code generation

### 7.3 Normative Language

The specification uses RFC 2119 keywords to distinguish requirements:

- **MUST / MUST NOT**: Absolute requirement / prohibition
- **SHOULD / SHOULD NOT**: Recommended / not recommended (valid reasons to deviate)
- **MAY**: Optional behavior

### 7.4 Specification Documents

Following CloudEvents' separation of normative and informative content:

| Document      | Type        | Content                                                               |
| ------------- | ----------- | --------------------------------------------------------------------- |
| `spec.md`     | Normative   | Core resource definitions, validation rules, reconciliation semantics |
| `primer.md`   | Informative | Concepts, architecture rationale, getting started                     |
| `adapters.md` | Normative   | Adapter interface contracts, registration, discovery                  |
| `policy.md`   | Normative   | Quality gate schema, enforcement levels, evaluation semantics         |
| `autonomy.md` | Normative   | Autonomy levels, promotion criteria, demotion triggers                |
| `agents.md`   | Normative   | Agent role schema, handoff contracts, orchestration topology          |
| `metrics.md`  | Normative   | Standard metric definitions, observability conventions                |
| `glossary.md` | Informative | Term definitions                                                      |
| `rfcs/`       | Process     | Enhancement proposals following KEP/OTEP pattern                      |

---

## 8. Core Resource Types

### 8.1 Pipeline

Defines a complete SDLC workflow from trigger through delivery.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: feature-delivery
  namespace: team-alpha
spec:
  triggers:
    - event: issue.assigned
      filter: { labels: ["ai-eligible"] }
  providers:
    issueTracker:
      type: linear # Swappable: linear | jira | github-issues
      config: { teamId: "ENG" }
    sourceControl:
      type: github # Swappable: github | gitlab | bitbucket
      config: { org: "reliable-genius" }
  stages:
    - name: implement
      agent: code-agent
      qualityGates: [test-coverage, security-scan]
    - name: review
      agent: reviewer-agent
      qualityGates: [human-approval]
    - name: deploy
      agent: deploy-agent
      qualityGates: [staging-verification]
  routing:
    complexityThresholds:
      low: { min: 1, max: 3, strategy: "fully-autonomous" }
      medium: { min: 4, max: 6, strategy: "ai-with-review" }
      high: { min: 7, max: 8, strategy: "ai-assisted" }
      critical: { min: 9, max: 10, strategy: "human-led" }
status:
  phase: Running
  activeStage: implement
  conditions:
    - type: Healthy
      status: "True"
      lastTransitionTime: "2026-02-07T10:00:00Z"
```

### 8.2 AgentRole

Declares an AI agent's identity, capabilities, constraints, and handoff behavior. Combines CrewAI's Role-Goal-Backstory pattern with A2A Agent Card discovery and LangGraph-style graph topology.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: code-agent
spec:
  role: "Senior Software Engineer"
  goal: "Implement features from specifications with clean, tested code"
  backstory: "Expert in TypeScript and Python with focus on testable architecture"
  tools: [code_editor, terminal, git_client, test_runner]
  constraints:
    maxFilesPerChange: 20
    requireTests: true
    allowedLanguages: [python, typescript]
    blockedPaths: ["**/secrets/**", "**/\.env*"]
  handoffs:
    - target: reviewer-agent
      trigger: "implementation_complete"
      contract:
        schema: "handoff-schemas/impl-to-review-v1.json"
        requiredFields: [prUrl, testResults, coverageReport, changeSummary]
    - target: tester-agent
      trigger: "implementation_complete"
  skills:
    - id: implement_feature
      description: "Implements features from ticket specifications"
      tags: [coding, implementation]
      examples:
        - input: "Implement user authentication with OAuth2"
          output: "PR with auth module, tests, and documentation"
  agentCard:                         # A2A-compatible discovery
    endpoint: "https://agents.internal/code-agent"
    version: "1.0.0"
    securitySchemes: [bearer_token]
status:
  autonomyLevel: 2
  totalTasksCompleted: 142
  approvalRate: 0.94
  lastActive: "2026-02-07T09:45:00Z"
```

### 8.3 QualityGate

Defines policy rules with graduated enforcement, following OPA/Gatekeeper's template/instance separation and Sentinel's three-tier enforcement model.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: ai-code-standards
spec:
  scope:
    repositories: ["org/service-*"]
    authorTypes: ["ai-agent"] # Applies only to AI-generated code
  gates:
    - name: test-coverage
      enforcement: soft-mandatory # advisory | soft-mandatory | hard-mandatory
      rule:
        metric: line-coverage
        operator: ">="
        threshold: 80
      override:
        requiredRole: engineering-manager
        requiresJustification: true
    - name: security-scan
      enforcement: hard-mandatory
      rule:
        tool: semgrep
        maxSeverity: medium
        rulesets: ["owasp-top-10"]
    - name: human-review
      enforcement: hard-mandatory
      rule:
        minimumReviewers: 2
        aiAuthorRequiresExtraReviewer: true
    - name: documentation
      enforcement: advisory
      rule:
        changedFilesRequireDocUpdate: true
    - name: provenance
      enforcement: hard-mandatory
      rule:
        requireAttribution: true # Model, tool, prompt hash, timestamp
        requireHumanReview: true
  evaluation:
    pipeline: pre-merge # When to evaluate
    timeout: 300s
    retryPolicy:
      maxRetries: 3
      backoff: exponential
status:
  compliant: false
  conditions:
    - type: TestCoverage
      status: "False"
      reason: "3 PRs below threshold"
      lastEvaluated: "2026-02-07T09:30:00Z"
    - type: SecurityScan
      status: "True"
    - type: HumanReview
      status: "True"
```

### 8.4 AutonomyPolicy

Declares progressive autonomy levels with quantitative promotion criteria and automatic demotion triggers. This is the most novel and differentiated resource type in the framework.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AutonomyPolicy
metadata:
  name: standard-progression
spec:
  levels:
    - level: 0
      name: "Intern"
      description: "Read-only observation, no code generation"
      permissions:
        read: ["*"]
        write: []
        execute: []
      guardrails:
        requireApproval: all
      monitoring: continuous
      minimumDuration: "2w" # 2 weeks minimum at this level

    - level: 1
      name: "Junior"
      description: "Recommend changes with mandatory human approval"
      permissions:
        read: ["*"]
        write: ["draft-pr", "comment"]
        execute: ["test-suite"]
      guardrails:
        requireApproval: all
        maxLinesPerPR: 200
        blockedPaths: ["**/auth/**", "**/payment/**"]
      monitoring: continuous
      minimumDuration: "4w"

    - level: 2
      name: "Senior"
      description: "Execute within guardrails with real-time notification"
      permissions:
        read: ["*"]
        write: ["branch", "pr", "comment"]
        execute: ["test-suite", "lint", "build"]
      guardrails:
        requireApproval: security-critical-only
        maxLinesPerPR: 500
        transactionLimit: "$100/day"
        blockedPaths: ["**/auth/**"]
      monitoring: real-time-notification
      minimumDuration: "8w"

    - level: 3
      name: "Principal"
      description: "Autonomous within domain, continuous validation"
      permissions:
        read: ["*"]
        write: ["branch", "pr", "comment", "merge-non-critical"]
        execute: ["test-suite", "lint", "build", "deploy-staging"]
      guardrails:
        requireApproval: architecture-changes-only
        maxLinesPerPR: 1000
      monitoring: audit-log
      minimumDuration: null # No minimum; continuous validation

  promotionCriteria:
    "0-to-1":
      minimumTasks: 20
      conditions:
        - metric: recommendation-acceptance-rate
          operator: ">="
          threshold: 0.90
        - metric: security-incidents
          operator: "=="
          threshold: 0
      requiredApprovals: [engineering-manager]

    "1-to-2":
      minimumTasks: 50
      conditions:
        - metric: pr-approval-rate
          operator: ">="
          threshold: 0.90
        - metric: rollback-rate
          operator: "<="
          threshold: 0.02
        - metric: average-review-iterations
          operator: "<="
          threshold: 1.5
        - metric: security-incidents
          operator: "=="
          threshold: 0
        - metric: code-coverage-maintained
          operator: ">="
          threshold: 0.80
      requiredApprovals: [engineering-manager, security-lead]

    "2-to-3":
      minimumTasks: 100
      conditions:
        - metric: pr-approval-rate
          operator: ">="
          threshold: 0.95
        - metric: rollback-rate
          operator: "<="
          threshold: 0.01
        - metric: production-incidents-caused
          operator: "=="
          threshold: 0
      requiredApprovals: [engineering-manager, security-lead, vp-engineering]

  demotionTriggers:
    - trigger: critical-security-incident
      action: demote-to-0
      cooldown: "4w"
    - trigger: rollback-rate-exceeds-5-percent
      action: demote-one-level
      cooldown: "2w"
    - trigger: unauthorized-access-attempt
      action: demote-to-0
      cooldown: "4w"

status:
  agents:
    - name: code-agent
      currentLevel: 2
      promotedAt: "2026-01-15T00:00:00Z"
      nextEvaluationAt: "2026-03-15T00:00:00Z"
      metrics:
        prApprovalRate: 0.94
        rollbackRate: 0.01
        reviewIterations: 1.2
```

### 8.5 AdapterBinding

Declares a tool integration as a swappable provider behind a uniform interface.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: linear-tracker
spec:
  interface: IssueTracker # The abstract contract
  type: linear # The concrete implementation
  version: "1.2.0"
  source: "registry.ai-sdlc.io/adapters/linear"
  config:
    apiKey:
      secretRef: linear-api-key
    teamId: "ENG"
    defaultLabels: ["ai-sdlc-managed"]
  healthCheck:
    interval: 60s
    timeout: 10s
status:
  connected: true
  lastHealthCheck: "2026-02-07T10:00:00Z"
  adapterVersion: "1.2.0"
  specVersionSupported: "v1alpha1"
```

---

## 9. Adapter Layer

### 9.1 Interface Contracts

The adapter layer defines typed interface contracts for each integration category, following Terraform's provider model. Each adapter is a standalone module implementing one or more of these interfaces:

#### IssueTracker

```
listIssues(filter: IssueFilter): Issue[]
getIssue(id: string): Issue
createIssue(input: CreateIssueInput): Issue
updateIssue(id: string, input: UpdateIssueInput): Issue
transitionIssue(id: string, transition: string): Issue
watchIssues(filter: IssueFilter): EventStream<IssueEvent>
```

#### SourceControl

```
createBranch(input: CreateBranchInput): Branch
createPR(input: CreatePRInput): PullRequest
mergePR(id: string, strategy: MergeStrategy): MergeResult
getFileContents(path: string, ref: string): FileContent
listChangedFiles(prId: string): ChangedFile[]
setCommitStatus(sha: string, status: CommitStatus): void
watchPREvents(filter: PRFilter): EventStream<PREvent>
```

#### CIPipeline

```
triggerBuild(input: TriggerBuildInput): Build
getBuildStatus(id: string): BuildStatus
getTestResults(buildId: string): TestResults
getCoverageReport(buildId: string): CoverageReport
watchBuildEvents(filter: BuildFilter): EventStream<BuildEvent>
```

#### CodeAnalysis

```
runScan(input: ScanInput): ScanResult
getFindings(scanId: string): Finding[]
getSeveritySummary(scanId: string): SeveritySummary
```

#### Messenger

```
sendNotification(input: NotificationInput): void
createThread(input: ThreadInput): Thread
postUpdate(threadId: string, message: string): void
```

### 9.2 Adapter Registration

Every adapter MUST include a `metadata.yaml`:

```yaml
name: linear
displayName: "Linear Issue Tracker"
description: "Adapter for Linear project management"
version: "1.2.0"
stability: beta # alpha | beta | stable | deprecated
interfaces:
  - IssueTracker@v1
owner: "@reliable-genius/adapters-team"
repository: "https://github.com/ai-sdlc/adapter-linear"
specVersions: ["v1alpha1"]
dependencies:
  runtime: ">=0.1.0"
```

### 9.3 Adapter Discovery

Adapters are discovered from one of three sources:

1. **Registry**: `registry.ai-sdlc.io/adapters/<name>@<version>` (like Terraform Registry)
2. **Local directory**: `./adapters/<name>/` for development
3. **Git reference**: `github.com/org/adapter@version` (like GitHub Actions `uses:`)

### 9.4 Custom Distribution Builder

Following OpenTelemetry's Collector Builder pattern, a `builder` tool assembles custom distributions from a manifest:

```yaml
# builder-manifest.yaml
spec_version: v1alpha1
adapters:
  - name: linear
    version: "1.2.0"
  - name: github
    version: "2.0.0"
  - name: semgrep
    version: "1.0.0"
  - name: slack
    version: "1.1.0"
output:
  name: my-ai-sdlc
  version: "1.0.0"
```

---

## 10. Policy Layer

### 10.1 Enforcement Levels

Three enforcement levels, adapted from HashiCorp Sentinel:

| Level              | Behavior                                                                           | Use Case                                                                 |
| ------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **advisory**       | Policy can fail; warning logged and posted as PR comment; dashboard updated        | New policies being validated; non-critical recommendations               |
| **soft-mandatory** | Policy must pass UNLESS an authorized user explicitly overrides with justification | Standard quality gates; enables accountability while allowing pragmatism |
| **hard-mandatory** | Policy must pass; no override possible                                             | Security-critical gates; regulatory requirements; production safety      |

### 10.2 Evaluation Pipeline

The enforcement pipeline mirrors Kubernetes admission controllers:

```
Request (PR, deploy, etc.)
  → Authentication (who is the actor?)
  → Authorization (is this actor allowed this action?)
  → Mutating Gates (auto-enrich: add labels, assign reviewers, inject metadata)
  → Validation (schema and structural checks)
  → Enforcing Gates (evaluate quality gate rules; accept/reject)
  → Admission (proceed or block)
```

### 10.3 Policy Expression

Policies can be expressed in two forms:

1. **Declarative YAML** (Kyverno-style, no separate language): For common patterns like threshold checks, reviewer requirements, and label enforcement. Accessible to teams without policy language expertise.
2. **Rego / CEL** (OPA-style, for complex logic): For policies requiring complex evaluation such as cross-resource checks, temporal conditions, or custom scoring.

### 10.4 AI-Specific Quality Gate Extensions

Beyond standard CI/CD gates, the framework defines AI-specific gates:

| Gate                              | Purpose                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| **AI Attribution**                | Verify code is correctly attributed as AI-generated and human-reviewed |
| **Provenance Tracking**           | Record model, tool, prompt hash, and timestamp for every AI artifact   |
| **Stricter Initial Thresholds**   | Higher coverage and security requirements for AI-generated code        |
| **LLM Evaluation**                | Run factuality, hallucination, and relevance checks on AI outputs      |
| **Complexity-Routing Compliance** | Verify task was routed to appropriate autonomy tier                    |

---

## 11. Runtime Layer — The Reconciliation Engine

### 11.1 The Core Loop

The Kubernetes controller pattern — **desired state → observe → diff → act → loop** — is the architectural heart of the AI-SDLC Framework. This transforms SDLC governance from point-in-time checks into continuous convergence toward declared policy.

```
┌───────────────────────────────────────────────┐
│              RECONCILIATION LOOP               │
│                                                │
│  1. DESIRED STATE                              │
│     Read SDLCPolicy, QualityGate,              │
│     AutonomyPolicy resources                   │
│              │                                 │
│  2. OBSERVE  ▼                                 │
│     Watch: GitHub/GitLab webhooks,             │
│     CI results, coverage APIs,                 │
│     security scanners, deploy platforms        │
│              │                                 │
│  3. DIFF     ▼                                 │
│     Compare actual metrics against             │
│     policy thresholds per PR / per repo        │
│              │                                 │
│  4. ACT      ▼                                 │
│     hard-mandatory → block merge               │
│     soft-mandatory → block + allow override    │
│     advisory → comment + dashboard             │
│              │                                 │
│  5. REMEDIATE ▼                                │
│     Auto-heal: generate missing tests,         │
│     assign reviewers, create tickets           │
│              │                                 │
│  6. UPDATE STATUS ▼                            │
│     Write compliance state to                  │
│     resource status.conditions[]               │
│              │                                 │
│  7. REQUEUE  ▼                                 │
│     Event-driven (real-time) +                 │
│     periodic (drift detection)                 │
│              │                                 │
│     └────────┘ (loop)                          │
└───────────────────────────────────────────────┘
```

### 11.2 Key Properties

The reconciliation engine MUST exhibit these properties:

- **Level-triggered, not edge-triggered**: Decisions based on current state difference, not specific events
- **Idempotent**: Same reconciliation produces same result regardless of invocation count
- **Eventually consistent**: Converges over time through repeated reconciliation
- **Rate-limited with backoff**: Exponential backoff on failures, deduplicating work queue
- **Filtered**: Predicates ignore status-only updates to prevent infinite loops

### 11.3 Reconciliation Results

Each reconciliation cycle returns one of:

| Result               | Behavior                         |
| -------------------- | -------------------------------- |
| **Success**          | Done until next event            |
| **Error**            | Requeue with exponential backoff |
| **Explicit Requeue** | Immediate retry                  |
| **Delayed Requeue**  | Check again in N minutes         |

---

## 12. Progressive Autonomy System

### 12.1 Autonomy Level Framework

Synthesized from three independently converging frameworks:

| Level | Name      | CSA ATF Analog | Knight-Columbia Analog      | Permissions                                       |
| ----- | --------- | -------------- | --------------------------- | ------------------------------------------------- |
| **0** | Observer  | —              | L1 Operator                 | Read-only; observe and learn                      |
| **1** | Junior    | Intern         | L2 Collaborator             | Recommend; all changes require approval           |
| **2** | Senior    | Junior/Senior  | L3 Consultant / L4 Approver | Execute within guardrails; real-time notification |
| **3** | Principal | Principal      | L5 Observer                 | Autonomous within domain; audit trail             |

### 12.2 The Principle of Least Autonomy

Agents MUST operate at the **lowest autonomy level sufficient for their function**, extending the cybersecurity Principle of Least Privilege. Every agent starts at Level 0 or Level 1.

### 12.3 Complexity-Based Task Routing

Task complexity determines the minimum autonomy level and human involvement required:

| Complexity   | Score | Strategy                                 | Human Role            |
| ------------ | ----- | ---------------------------------------- | --------------------- |
| **Low**      | 1–3   | Fully autonomous with automated gates    | None (post-hoc audit) |
| **Medium**   | 4–6   | AI-generated with mandatory human review | Reviewer              |
| **High**     | 7–8   | AI-assisted with architect oversight     | Collaborator          |
| **Critical** | 9–10  | Human-led with AI support                | Owner                 |

### 12.4 Promotion and Demotion

Promotion is quantitative, requiring sustained performance across multiple metrics (see AutonomyPolicy resource definition in Section 8.4). Demotion is automatic and immediate on trigger events. This bidirectional system ensures that trust is continuously verified, not assumed.

---

## 13. Multi-Agent Orchestration

### 13.1 Orchestration Patterns

The framework supports five orchestration patterns:

| Pattern          | Description                                                      | Use Case                                         |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| **Sequential**   | Agents in series (implement → review → deploy)                   | Standard feature delivery                        |
| **Parallel**     | Multiple agents work simultaneously; outputs combined            | Code + tests in parallel; 30-40% error reduction |
| **Hierarchical** | Supervisor decomposes and delegates                              | Complex feature breakdown                        |
| **Swarm**        | Semi-autonomous agents with local coordination                   | Large-scale refactoring                          |
| **Hybrid**       | Hierarchical planning + parallel execution + structured handoffs | Most production systems                          |

### 13.2 Handoff Contracts

Inter-agent transfers MUST be treated as versioned API contracts. Every agent transition produces a typed, validated, auditable artifact:

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

### 13.3 Agent State Management

The framework defines standard interfaces for multi-tier agent memory:

| Tier                  | Scope                  | Persistence       | Use                             |
| --------------------- | ---------------------- | ----------------- | ------------------------------- |
| **Working Memory**    | Current context window | Ephemeral         | Active task execution           |
| **Short-Term Memory** | Within session         | Session-scoped    | Multi-step task context         |
| **Long-Term Memory**  | Across sessions        | Persistent store  | Learning, preferences, patterns |
| **Shared Memory**     | Multi-agent            | Distributed store | Coordination, shared context    |
| **Episodic Memory**   | Historical events      | Append-only log   | Audit trail, experience replay  |

### 13.4 Agent Discovery

Agents SHOULD publish A2A-compatible Agent Cards at `/.well-known/agent.json`, enabling dynamic discovery of capabilities, skills, version, and security schemes.

---

## 14. Metrics and Observability

### 14.1 AI-SDLC Metrics Framework

Beyond DORA's four keys, AI-augmented development requires purpose-built measurements organized into five categories:

#### Task Effectiveness

- Agent success rate (tasks completed / tasks assigned)
- Task completion time vs. human baseline
- Time-to-resolution by complexity tier

#### Human-in-Loop Indicators

- Human intervention rate
- Escalation frequency
- Override rate (measuring actual vs. declared autonomy)

#### Code Quality

- Acceptance rate (% accepted without modification; baseline: 27-30%)
- AI code defect density vs. human code defect density
- Churn rate (AI code shows ~41% higher churn — target reduction)
- Security scan pass rate by author type

#### Economic Efficiency

- Cost per task (tokens + compute + human review time)
- Model usage mix (% using cheaper vs. expensive models)
- Cache hit rate
- Total cost of ownership per feature delivered

#### Autonomy Trajectory

- Autonomy level over time per agent
- Task complexity handled at each level
- Intervention rate trend (should decrease over time)
- Time-to-promotion per level transition

### 14.2 OpenTelemetry Integration

The framework SHOULD define semantic conventions for AI-SDLC observability, extending OpenTelemetry's GenAI semantic conventions:

- **Traces**: Span per pipeline stage, per agent task, per quality gate evaluation
- **Metrics**: Gauge for autonomy level, counter for gate pass/fail, histogram for task duration
- **Logs**: Structured logs for all reconciliation decisions, promotions, demotions, overrides

### 14.3 Provenance Tracking

Every AI-generated artifact MUST record:

| Field            | Description                                                  |
| ---------------- | ------------------------------------------------------------ |
| `model`          | Model identifier (e.g., `claude-sonnet-4-5-20250929`)        |
| `tool`           | Tool that generated the artifact (e.g., `claude-code@1.2.0`) |
| `promptHash`     | SHA-256 of the input prompt                                  |
| `timestamp`      | ISO 8601 generation time                                     |
| `humanReviewer`  | Identity of the human who reviewed (if applicable)           |
| `reviewDecision` | `approved` / `rejected` / `revised`                          |

---

## 15. Enterprise Readiness

### 15.1 Identity and Access Control

Traditional RBAC is insufficient for AI agents because their roles change moment-to-moment. The framework supports:

- **Dynamic Role Assignment**: Contextual permissions adjusting based on task context and autonomy level
- **ABAC (Attribute-Based Access Control)**: Evaluating user, resource, environment, and action attributes
- **Just-in-Time Access**: Short-lived credentials scoped to specific tasks
- **Policy-Based Authorization**: External authorization service vetting every tool invocation

### 15.2 Three-Layer Defense-in-Depth

| Layer                   | Controls                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| **Environment**         | Sandboxing (Firecracker, gVisor, hardened containers), network segmentation, read-only source mirrors |
| **Permissions**         | Scoped tokens, time-boxed credentials, file-tree allowlists, policy enforcers gating every action     |
| **Runtime Enforcement** | Real-time monitoring, human approval for risky diffs, git hooks, CI gates, kill switches              |

### 15.3 Risk-Tiered Approval Workflows

| Tier       | Scope                                            | Approval                                                   |
| ---------- | ------------------------------------------------ | ---------------------------------------------------------- |
| **Tier 1** | Documentation, tests, simple config              | Automated gates only                                       |
| **Tier 2** | Feature code, bug fixes                          | Automated gates + single human reviewer                    |
| **Tier 3** | Cross-service changes, API modifications         | Multiple reviewers including domain expert                 |
| **Tier 4** | Security-critical, cryptographic, authentication | Architecture review board; AI generation may be prohibited |

### 15.4 Audit Trail

Every action in the system MUST produce an immutable, tamper-evident audit log entry including: actor identity, action type, resource affected, policy evaluated, decision rendered, and timestamp.

---

## 16. Repository Structure

Following the multi-repo pattern proven by Kubernetes, OpenTelemetry, and GraphQL:

```
ai-sdlc/
├── spec/                            # Formal specification (Markdown)
│   ├── spec.md                      # Core resource definitions
│   ├── primer.md                    # Concepts and architecture guide
│   ├── adapters.md                  # Adapter interface contracts
│   ├── policy.md                    # Quality gate specification
│   ├── autonomy.md                  # Progressive autonomy specification
│   ├── agents.md                    # Agent orchestration specification
│   ├── metrics.md                   # Metrics and observability conventions
│   ├── glossary.md                  # Term definitions
│   ├── schemas/                     # OpenAPI v3 / JSON Schema definitions
│   │   ├── pipeline.schema.json
│   │   ├── agent-role.schema.json
│   │   ├── quality-gate.schema.json
│   │   ├── autonomy-policy.schema.json
│   │   └── adapter-binding.schema.json
│   └── rfcs/                        # Enhancement proposals (KEP/OTEP-style)
│       ├── RFC-0001-template.md
│       └── README.md                # RFC process documentation
│
├── reference/                       # Reference implementation
│   ├── src/                         # Source mirroring spec sections
│   │   ├── core/                    # Resource model, validation
│   │   ├── adapters/                # Built-in adapter implementations
│   │   │   ├── github/
│   │   │   ├── linear/
│   │   │   └── metadata.yaml        # Per-component stability tracking
│   │   ├── policy/                  # Policy evaluation engine
│   │   ├── reconciler/              # Reconciliation loop
│   │   └── agents/                  # Agent orchestration runtime
│   └── package.json
│
├── conformance/                     # Language-agnostic test suite
│   ├── tests/
│   │   ├── v1alpha1/                # Organized by spec version
│   │   │   ├── pipeline/
│   │   │   ├── quality-gate/
│   │   │   ├── autonomy-policy/
│   │   │   └── adapter/
│   │   └── README.md
│   └── runner/                      # Test runner tooling
│
├── contrib/                         # Community adapters/plugins
│   ├── adapters/
│   │   ├── jira/
│   │   ├── gitlab/
│   │   ├── bitbucket/
│   │   ├── sonarqube/
│   │   └── semgrep/
│   └── builder-manifest.yaml        # Custom distribution assembly
│
├── sdk-typescript/                  # TypeScript SDK (independently versioned)
├── sdk-python/                      # Python SDK (independently versioned)
├── sdk-go/                          # Go SDK (independently versioned)
│
├── docs/                            # Documentation website
│   ├── getting-started/
│   ├── tutorials/
│   ├── api-reference/               # Auto-generated from schemas
│   └── examples/
│
└── community/                       # Governance and process
    ├── CHARTER.md
    ├── GOVERNANCE.md
    ├── CODE_OF_CONDUCT.md
    ├── CONTRIBUTING.md
    ├── ADOPTERS.md
    ├── sigs/                        # Special Interest Groups
    │   ├── sig-spec/
    │   ├── sig-adapters/
    │   └── sig-security/
    └── meetings/                    # Meeting notes
```

### 16.1 Repository Relationships

- **Spec** versions independently from implementations (`v1.0`, `v1.1`)
- **Implementations** use SemVer and document which spec version they support
- **Conformance tests** are consumable as a git submodule by any implementation
- Reference implementation source structure MUST mirror spec sections for traceability
- Spec changes require: RFC → working group review → reference implementation PoC → formal approval

---

## 17. Versioning and Evolution Strategy

### 17.1 API Version Maturity

Following Kubernetes' proven progression:

| Stage     | Format                 | Stability Guarantee                         | Breaking Changes               |
| --------- | ---------------------- | ------------------------------------------- | ------------------------------ |
| **Alpha** | `v1alpha1`, `v1alpha2` | No stability; may be removed without notice | Allowed between alpha versions |
| **Beta**  | `v1beta1`, `v1beta2`   | 9 months of support after deprecation       | Allowed between beta versions  |
| **GA**    | `v1`, `v2`             | 12 months of support after deprecation      | Only between major versions    |

### 17.2 Component-Level Stability

Every component (adapter, policy template, agent role) carries its own stability level in `metadata.yaml`, following the OpenTelemetry pattern:

- `Development` → `Alpha` → `Beta` → `Stable` → `Deprecated` → `Removed`

Each signal/component can progress independently.

### 17.3 Enhancement Proposal Process

Spec changes flow through a formal RFC process modeled on Kubernetes KEPs and OpenTelemetry OTEPs:

1. **RFC Draft**: Author creates `rfcs/RFC-NNNN-title.md` with motivation, design, alternatives considered
2. **Working Group Review**: Relevant SIG reviews for design soundness
3. **Reference Implementation PoC**: Author demonstrates feasibility with a proof-of-concept PR
4. **Formal Approval**: Two maintainer approvals + 7-day comment period
5. **Spec Update**: RFC merged, spec updated, conformance tests added

---

## 18. Conformance and Certification

### 18.1 Conformance Test Suite

Following JSON Schema's language-agnostic approach, the conformance suite consists of pure JSON/YAML test data:

```json
{
  "description": "QualityGate with soft-mandatory enforcement allows override",
  "specVersion": "v1alpha1",
  "resourceType": "QualityGate",
  "input": {
    "gate": {
      "enforcement": "soft-mandatory",
      "rule": { "metric": "coverage", "threshold": 80 }
    },
    "observed": { "coverage": 72 },
    "override": {
      "actor": "eng-manager",
      "justification": "Hotfix for P0 incident"
    }
  },
  "expected": {
    "decision": "allowed-with-override",
    "status": "False",
    "auditEntry": true
  }
}
```

### 18.2 Conformance Levels

| Level       | Requirements                                                                       |
| ----------- | ---------------------------------------------------------------------------------- |
| **Core**    | Passes all core resource validation tests; implements Pipeline, QualityGate        |
| **Adapter** | Passes adapter interface contract tests for at least one interface                 |
| **Full**    | Passes all tests including autonomy, multi-agent orchestration, and reconciliation |

---

## 19. Regulatory Alignment

The AI-SDLC Framework is designed to facilitate compliance with three major regulatory frameworks:

| Regulation        | AI-SDLC Mapping                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EU AI Act**     | Risk-tier classification maps to complexity-based routing; transparency requirements map to provenance tracking; high-risk AI system requirements map to quality gates and audit trails |
| **NIST AI RMF**   | Govern → AutonomyPolicy; Map → Pipeline complexity routing; Measure → Metrics framework; Manage → Reconciliation engine + demotion triggers                                             |
| **ISO/IEC 42001** | Plan → Pipeline spec; Do → Agent execution; Check → Quality gates + reconciliation; Act → Auto-remediation + demotion                                                                   |

The framework also aligns with:

- **ISO/IEC/IEEE 12207:2017**: SDLC process architecture (verification, validation, configuration management, traceability)
- **OWASP ASI Top 10 (2026)**: Threat categories for agentic AI (memory poisoning, tool misuse, supply chain compromise)
- **CSA Agentic Trust Framework**: Zero Trust principles for AI agents

---

## 20. Launch Phasing

### Phase 0: Pre-Launch (Months 1–3)

- Finalize spec v0.1 with 5–10 design partners
- Build reference implementation in TypeScript
- Implement GitHub and Linear adapters as first provider implementations to validate interface contracts
- Create conformance test suite for core resource types
- Establish RFC process and community governance

### Phase 1: Public Launch (Month 4)

- Publish spec v0.1 under Apache 2.0
- Publish reference implementation with GitHub + Linear adapters
- Blog post, design partner endorsements
- CNCF Sandbox submission
- Target: initial community adoption, first external contributors

### Phase 2: Growth (Months 5–12)

- Weekly community calls
- Conference speaking (KubeCon, QCon, AI Engineering Summit)
- First conformant third-party integrations
- Additional adapters: GitLab, Jira, Bitbucket, SonarQube, Semgrep
- Python and Go SDKs
- Target: 1,000+ GitHub stars, 50+ contributors

### Phase 3: Maturation (Months 13–24)

- Spec v1.0 (GA for core resources)
- Conformance certification program
- CNCF Incubation application
- Enterprise adoption case studies
- Target: 50+ conformant tools, multi-vendor governance

### Content Strategy

- 70% problem-space education (governance gap, AI coding risks, productivity paradox)
- 30% project updates and technical deep-dives
- Channels: HackerNews, Reddit, Dev.to, conference talks

---

## 21. Glossary

| Term                    | Definition                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Adapter**             | A standalone module implementing one or more interface contracts for a specific tool (e.g., Linear adapter implements IssueTracker) |
| **Autonomy Level**      | A numbered tier (0–3) defining the permissions, guardrails, and monitoring intensity for an AI agent                                |
| **Demotion**            | Automatic reduction of an agent's autonomy level triggered by a policy violation                                                    |
| **Enforcement Level**   | The strictness of a quality gate: advisory, soft-mandatory, or hard-mandatory                                                       |
| **Handoff Contract**    | A versioned JSON Schema defining the required data structure for inter-agent transitions                                            |
| **Promotion**           | Advancement of an agent's autonomy level after meeting quantitative criteria and receiving explicit approval                        |
| **Quality Gate**        | A policy rule evaluated against development activity with a defined enforcement level                                               |
| **Reconciliation Loop** | The continuous process of observing current state, diffing against desired state, and acting to close the gap                       |
| **Resource**            | A declarative object with apiVersion, kind, metadata, spec, and status fields                                                       |
| **Spec/Status Split**   | The separation of user intent (spec) from system-observed reality (status) in every resource                                        |

---

## 22. References

### Standards and Specifications

- Kubernetes Resource Model: https://kubernetes.io/docs/concepts/overview/working-with-objects/
- OpenTelemetry Specification: https://opentelemetry.io/docs/specs/
- CloudEvents Specification: https://cloudevents.io/
- Model Context Protocol (MCP): https://modelcontextprotocol.io/
- Google A2A Protocol: https://github.com/google/A2A
- OpenAI AGENTS.md: https://openai.com/index/agents-md/

### Governance Frameworks

- Cloud Security Alliance Agentic Trust Framework (February 2026)
- Knight-Columbia Autonomy Levels (Feng, McDonald & Zhang, July 2025)
- OWASP Agentic Security Initiative Top 10 (2026)
- ISO/IEC 42001:2023 — AI Management Systems
- ISO/IEC/IEEE 12207:2017 — Software Lifecycle Processes
- NIST AI Risk Management Framework

### Policy Engines

- OPA / Gatekeeper: https://open-policy-agent.github.io/gatekeeper/
- Kyverno: https://kyverno.io/
- HashiCorp Sentinel: https://www.hashicorp.com/sentinel

### Multi-Agent Frameworks

- CrewAI: https://crewai.com/
- LangGraph: https://langchain-ai.github.io/langgraph/
- AutoGen / Microsoft Agent Framework
- OpenAI Agents SDK

### Research

- METR Randomized Controlled Trial on AI Coding Tools (2025)
- Google DORA Report 2024 and 2025
- GitClear Code Quality Analysis (211M lines, 2021–2024)
- Veracode AI-Generated Code Security Study
- Stack Overflow Developer Survey, December 2025

---

_This document is licensed under Apache 2.0. It is intended to provide complete context for an AI agent to build out the AI-SDLC specification repository._
