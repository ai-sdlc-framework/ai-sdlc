# AI-SDLC Framework Specification

<!-- Source: PRD Sections 6, 7, 8, 11 -->

**Document type:** Normative
**Status:** Draft
**Spec version:** v1alpha1

---

## Table of Contents

1. [Introduction and Document Conventions](#1-introduction-and-document-conventions)
2. [Resource Model](#2-resource-model)
3. [Metadata Object](#3-metadata-object)
4. [The Spec/Status Split](#4-the-specstatus-split)
5. [Core Resource Types](#5-core-resource-types)
   - 5.1 [Pipeline](#51-pipeline)
   - 5.2 [AgentRole](#52-agentrole)
   - 5.3 [QualityGate](#53-qualitygate)
   - 5.4 [AutonomyPolicy](#54-autonomypolicy)
   - 5.5 [AdapterBinding](#55-adapterbinding)
6. [Conditions](#6-conditions)
7. [Schema Validation](#7-schema-validation)
8. [Versioning](#8-versioning)
9. [Reconciliation Semantics](#9-reconciliation-semantics)
10. [Extensibility](#10-extensibility)
11. [Conformance Levels](#11-conformance-levels)

### Document Map

| Document | Type | Description |
| --- | --- | --- |
| [spec.md](spec.md) (this document) | Normative | Core resource model, validation rules, reconciliation semantics |
| [primer.md](primer.md) | Informative | Concepts, architecture rationale, getting started |
| [adapters.md](adapters.md) | Normative | Adapter interface contracts, registration, discovery |
| [policy.md](policy.md) | Normative | Quality gate schema, enforcement levels, evaluation |
| [autonomy.md](autonomy.md) | Normative | Autonomy levels, promotion criteria, demotion triggers |
| [agents.md](agents.md) | Normative | Agent roles, handoff contracts, orchestration |
| [metrics.md](metrics.md) | Normative | Metric definitions, observability conventions |
| [glossary.md](glossary.md) | Informative | Term definitions |

---

## 1. Introduction and Document Conventions

### 1.1 Purpose

This document defines the core resource model, resource types, validation requirements, and reconciliation semantics for the AI-SDLC Framework. It is the foundational normative document upon which all other specification documents depend.

### 1.2 Notational Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

When these keywords appear in lowercase, they carry their normal English meaning and are not to be interpreted as RFC 2119 keywords.

### 1.3 Terminology

Terms defined in the [glossary](glossary.md) are used throughout this document. On first use, terms link to their glossary definition.

---

## 2. Resource Model

<!-- Source: PRD Section 7.1 -->

Every AI-SDLC [resource](glossary.md#resource) MUST carry five top-level fields:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: <ResourceType>
metadata:
  name: <unique-name>
  namespace: <team-or-project>
  labels: {}
  annotations: {}
spec: {}
status: {}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `apiVersion` | string | MUST | The API version of the resource. Format: `ai-sdlc.io/<version>`. |
| `kind` | string | MUST | The resource type. One of: `Pipeline`, `AgentRole`, `QualityGate`, `AutonomyPolicy`, `AdapterBinding`. |
| `metadata` | object | MUST | Identifying information for the resource. See [Section 3](#3-metadata-object). |
| `spec` | object | MUST | The desired state declared by the user. |
| `status` | object | MAY | The observed state reported by the system. |

The `apiVersion` field MUST be set to `ai-sdlc.io/v1alpha1` for all resources defined in this version of the specification.

The `kind` field MUST be one of the five core resource types defined in [Section 5](#5-core-resource-types), or a custom resource type as defined in [Section 10](#10-extensibility).

Implementations MUST reject resources with unrecognized `apiVersion` or `kind` values unless the implementation supports custom resource types and the resource conforms to the extensibility model.

---

## 3. Metadata Object

<!-- Source: PRD Section 7.1 -->

The `metadata` object MUST contain the following fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | MUST | A unique identifier within the [namespace](glossary.md#namespace). MUST match the pattern `^[a-z][a-z0-9-]*$` and MUST NOT exceed 253 characters. |
| `namespace` | string | SHOULD | The scoping unit, typically a team or project identifier. MUST match the pattern `^[a-z][a-z0-9-]*$` when provided. |
| `labels` | map[string]string | MAY | Arbitrary key-value pairs for selection and filtering. See [Section 3.1](#31-labels). |
| `annotations` | map[string]string | MAY | Non-identifying key-value pairs for tooling and operational metadata. See [Section 3.2](#32-annotations). |

Resource names MUST be unique within a namespace for a given `kind`. The combination of `namespace`, `kind`, and `name` uniquely identifies a resource.

### 3.1 Labels

[Labels](glossary.md#label) are key-value pairs attached to resources for identification and selection. Label keys and values MUST be strings. Label keys SHOULD follow the format `prefix/name` where the prefix is a DNS subdomain (e.g., `team.example.com/tier`). Labels without a prefix are reserved for end-user use.

Labels MAY be used by implementations to filter, select, and group resources. Quality gates and policies MAY use label selectors to target specific resources.

### 3.2 Annotations

[Annotations](glossary.md#annotation) are key-value pairs attached to resources for non-identifying metadata. Annotations MUST NOT be used for selection or filtering by the framework. Annotations are intended for:

- Build and release provenance
- Tooling configuration hints
- Links to external documentation or dashboards
- Operational notes

---

## 4. The Spec/Status Split

<!-- Source: PRD Section 7.1 -->

The [spec/status split](glossary.md#spec-status-split) is the foundational structural pattern of the AI-SDLC Framework.

- The `spec` field represents **desired state** — what the user intends. Users write to `spec`; the system reads from `spec`.
- The `status` field represents **observed state** — what the system has detected. The system writes to `status`; users read from `status`.

Implementations MUST treat `spec` as the source of truth for user intent. Implementations MUST NOT modify `spec` fields except through explicit user action. Implementations SHOULD update `status` fields to reflect current observed state. The [reconciliation loop](glossary.md#reconciliation-loop) continuously works to make observed state (`status`) match desired state (`spec`).

The `status` field is OPTIONAL on resource creation. When absent, it indicates the resource has not yet been reconciled.

---

## 5. Core Resource Types

The AI-SDLC Framework defines five core resource types. Each resource type has a formal [JSON Schema](schemas/) definition in addition to the normative text below.

### 5.1 Pipeline

<!-- Source: PRD Section 8.1 -->

A [Pipeline](glossary.md#pipeline) defines a complete SDLC workflow from trigger through delivery.

#### 5.1.1 Spec Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `triggers` | array[Trigger] | MUST | Events that initiate the pipeline. |
| `providers` | map[string]Provider | MUST | Tool integrations used by the pipeline. |
| `stages` | array[Stage] | MUST | Ordered list of execution stages. |
| `routing` | Routing | MAY | Complexity-based task routing configuration. |
| `branching` | [BranchingConfig](#branching-config-object) | MAY | Branch naming, target, and cleanup policy. |
| `pullRequest` | [PullRequestConfig](#pull-request-config-object) | MAY | PR creation conventions. |
| `notifications` | [NotificationsConfig](#notifications-config-object) | MAY | Named notification templates for pipeline events. |

**Trigger Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `event` | string | MUST | The event type that triggers the pipeline (e.g., `issue.assigned`, `pr.opened`). |
| `filter` | object | MAY | Conditions that must match for the trigger to fire. |

**Provider Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string | MUST | The adapter type (e.g., `linear`, `github`, `jira`). |
| `config` | object | MAY | Adapter-specific configuration. |

**Stage Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | MUST | Unique name within the pipeline. |
| `agent` | string | MAY | Reference to an AgentRole resource name. |
| `qualityGates` | array[string] | MAY | References to QualityGate resource names. |
| `onFailure` | [FailurePolicy](#failure-policy-object) | MAY | What to do when this stage fails. Defaults to `abort`. |
| `timeout` | string | MAY | Maximum stage duration as an ISO 8601 duration (e.g., `PT30M`). |
| `credentials` | [CredentialPolicy](#credential-policy-object) | MAY | JIT credential scope and lifetime for this stage. |
| `approval` | [ApprovalPolicy](#approval-policy-object) | MAY | Approval requirements before stage execution. |

**Routing Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `complexityThresholds` | map[string]Threshold | MAY | Named complexity tiers with score ranges and strategies. |

**Threshold Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `min` | integer | MUST | Minimum [complexity score](glossary.md#complexity-score) (inclusive). Range: 1-10. |
| `max` | integer | MUST | Maximum complexity score (inclusive). Range: 1-10. |
| `strategy` | string | MUST | One of: `fully-autonomous`, `ai-with-review`, `ai-assisted`, `human-led`. |

**FailurePolicy Object:** {#failure-policy-object}

<!-- Source: PRD Section 8.1, RFC-0002 -->

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `strategy` | string | MUST | One of: `abort`, `retry`, `pause`, `continue`. |
| `maxRetries` | integer | Conditional | Maximum retry attempts (1-10). MUST be present when `strategy` is `retry`. |
| `retryDelay` | string | MAY | Delay between retries as an ISO 8601 duration (e.g., `PT1M`). |
| `notification` | string | MAY | Name of a notification template to send on failure. |

**CredentialPolicy Object:** {#credential-policy-object}

<!-- Source: RFC-0002 -->

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `scope` | array[string] | MUST | Permission scopes required by the stage (minimum 1 item). |
| `ttl` | string | MAY | Credential time-to-live as an ISO 8601 duration. Default: `PT10M`. |
| `revokeOnComplete` | boolean | MAY | Whether to revoke credentials when the stage completes. Default: `true`. |

**ApprovalPolicy Object:** {#approval-policy-object}

<!-- Source: RFC-0002 -->

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `required` | boolean | MUST | Whether approval is required for this stage. |
| `tierOverride` | string | MAY | One of: `auto`, `peer-review`, `team-lead`, `security-review`. |
| `blocking` | boolean | MAY | Whether the stage blocks until approval is granted. Default: `true`. |
| `timeout` | string | MAY | Maximum time to wait for approval as an ISO 8601 duration. |
| `onTimeout` | string | MAY | One of: `abort`, `escalate`, `auto-approve`. |

**BranchingConfig Object:** {#branching-config-object}

<!-- Source: RFC-0002 -->

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | string | MUST | Branch name pattern with placeholders (e.g., `ai-sdlc/issue-{issueNumber}`). |
| `targetBranch` | string | MAY | Target branch for pull requests. Default: `main`. |
| `cleanup` | string | MAY | One of: `on-merge`, `on-close`, `manual`. |

**PullRequestConfig Object:** {#pull-request-config-object}

<!-- Source: RFC-0002 -->

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `titleTemplate` | string | MAY | PR title template with placeholders. |
| `descriptionSections` | array[string] | MAY | Sections to include in the PR description. |
| `includeProvenance` | boolean | MAY | Whether to include AI [provenance](glossary.md#provenance) metadata. Default: `true`. |
| `closeKeyword` | string | MAY | Keyword used to auto-close the linked issue (e.g., `Closes`). |

**NotificationsConfig Object:** {#notifications-config-object}

<!-- Source: RFC-0002 -->

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `templates` | map[string]NotificationTemplate | MAY | Named notification templates. |

**NotificationTemplate Object:** {#notification-template-object}

<!-- Source: RFC-0002 -->

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | string | MUST | One of: `issue`, `pr`, `both`. |
| `title` | string | MUST | Notification title template. |
| `body` | string | MAY | Notification body template with placeholders. |

#### 5.1.2 Status Fields

| Field | Type | Description |
| --- | --- | --- |
| `phase` | string | Current pipeline phase. One of: `Pending`, `Running`, `Succeeded`, `Failed`, `Suspended`. |
| `activeStage` | string | Name of the currently executing stage. |
| `conditions` | array[Condition] | Current state conditions. See [Section 6](#6-conditions). |
| `stageAttempts` | map[string]integer | Per-stage execution attempt counts. |
| `pendingApproval` | ApprovalStatus | Approval details when phase is `Suspended`. |

#### 5.1.3 Example

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
      type: linear
      config: { teamId: "ENG" }
    sourceControl:
      type: github
      config: { org: "reliable-genius" }
  stages:
    - name: implement
      agent: code-agent
      qualityGates: [test-coverage, security-scan]
      timeout: PT30M
      credentials:
        scope: ["repo:read", "repo:write"]
        ttl: PT15M
        revokeOnComplete: true
      onFailure:
        strategy: retry
        maxRetries: 2
        retryDelay: PT1M
        notification: agent-failure
    - name: review
      agent: reviewer-agent
      qualityGates: [human-approval]
      approval:
        required: true
        blocking: true
        timeout: PT24H
        onTimeout: abort
    - name: deploy
      agent: deploy-agent
      qualityGates: [staging-verification]
      onFailure:
        strategy: abort
  routing:
    complexityThresholds:
      low: { min: 1, max: 3, strategy: "fully-autonomous" }
      medium: { min: 4, max: 6, strategy: "ai-with-review" }
      high: { min: 7, max: 8, strategy: "ai-assisted" }
      critical: { min: 9, max: 10, strategy: "human-led" }
  branching:
    pattern: "ai-sdlc/issue-{issueNumber}"
    targetBranch: main
    cleanup: on-merge
  pullRequest:
    titleTemplate: "fix: {issueTitle} (#{issueNumber})"
    descriptionSections: [summary, changes, closes]
    includeProvenance: true
    closeKeyword: Closes
  notifications:
    templates:
      agent-failure:
        target: issue
        title: "AI-SDLC: Agent Failed"
        body: "Error during {stageName}: {details}"
      pr-created:
        target: issue
        title: "AI-SDLC: PR Created"
        body: "Pull request: {prUrl}"
status:
  phase: Running
  activeStage: implement
  stageAttempts:
    implement: 1
  conditions:
    - type: Healthy
      status: "True"
      lastTransitionTime: "2026-02-07T10:00:00Z"
```

---

### 5.2 AgentRole

<!-- Source: PRD Section 8.2 -->

An [AgentRole](glossary.md#agent-role) declares an AI agent's identity, capabilities, constraints, and handoff behavior. It combines the [Role-Goal-Backstory](glossary.md#role-goal-backstory) pattern with A2A Agent Card discovery.

#### 5.2.1 Spec Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `role` | string | MUST | The agent's role title (e.g., "Senior Software Engineer"). |
| `goal` | string | MUST | What the agent aims to achieve. |
| `backstory` | string | MAY | Context for the agent's persona and expertise. |
| `tools` | array[string] | MUST | Tool identifiers the agent is permitted to use. |
| `constraints` | Constraints | MAY | Operational limits on the agent. |
| `handoffs` | array[Handoff] | MAY | Transitions to other agents. |
| `skills` | array[Skill] | MAY | Declared capabilities for discovery. |
| `agentCard` | AgentCard | MAY | A2A-compatible discovery information. |

**Constraints Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `maxFilesPerChange` | integer | MAY | Maximum files the agent may modify in a single change. |
| `requireTests` | boolean | MAY | Whether the agent MUST include tests with code changes. |
| `allowedLanguages` | array[string] | MAY | Programming languages the agent may produce. |
| `blockedPaths` | array[string] | MAY | Glob patterns for paths the agent MUST NOT modify. |

**Handoff Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | string | MUST | Name of the target AgentRole resource. |
| `trigger` | string | MUST | Condition that initiates the handoff. |
| `contract` | HandoffContractRef | MAY | Reference to a [handoff contract](glossary.md#handoff-contract). |

**HandoffContractRef Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `schema` | string | MUST | URI or path to the JSON Schema defining the handoff data structure. |
| `requiredFields` | array[string] | MAY | Fields that MUST be present in the handoff payload. |

**Skill Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | MUST | Unique skill identifier. |
| `description` | string | MUST | Human-readable description of the skill. |
| `tags` | array[string] | MAY | Tags for categorization and discovery. |
| `examples` | array[SkillExample] | MAY | Input/output examples. |

**SkillExample Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | string | MUST | Example input. |
| `output` | string | MUST | Expected output description. |

**AgentCard Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `endpoint` | string (URI) | MUST | The agent's service endpoint. |
| `version` | string | MUST | Agent card version. |
| `securitySchemes` | array[string] | MAY | Supported authentication methods. |

#### 5.2.2 Status Fields

| Field | Type | Description |
| --- | --- | --- |
| `autonomyLevel` | integer | Current [autonomy level](glossary.md#autonomy-level) (0-3). |
| `totalTasksCompleted` | integer | Cumulative tasks completed. |
| `approvalRate` | number | Ratio of approved tasks (0.0-1.0). |
| `lastActive` | string (date-time) | Timestamp of last activity. |

#### 5.2.3 Example

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
    blockedPaths: ["**/secrets/**", "**/.env*"]
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
  agentCard:
    endpoint: "https://agents.internal/code-agent"
    version: "1.0.0"
    securitySchemes: [bearer_token]
status:
  autonomyLevel: 2
  totalTasksCompleted: 142
  approvalRate: 0.94
  lastActive: "2026-02-07T09:45:00Z"
```

---

### 5.3 QualityGate

<!-- Source: PRD Section 8.3 -->

A [QualityGate](glossary.md#quality-gate) defines policy rules with graduated [enforcement levels](glossary.md#enforcement-level), following OPA/Gatekeeper's template/instance separation and Sentinel's three-tier enforcement model.

#### 5.3.1 Spec Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `scope` | Scope | MAY | Targeting criteria for the gate. |
| `gates` | array[Gate] | MUST | Individual gate rules. |
| `evaluation` | Evaluation | MAY | When and how to evaluate. |

**Scope Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repositories` | array[string] | MAY | Repository patterns to match (glob). |
| `authorTypes` | array[string] | MAY | Author types to target (e.g., `ai-agent`, `human`). |

**Gate Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | MUST | Unique gate name within the QualityGate. |
| `enforcement` | string | MUST | One of: `advisory`, `soft-mandatory`, `hard-mandatory`. |
| `rule` | Rule | MUST | The evaluation rule. One of: metric-based, tool-based, or reviewer-based. |
| `override` | Override | MAY | Override configuration. Only valid for `soft-mandatory` enforcement. |

**Rule Object (metric-based):**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `metric` | string | MUST | The metric to evaluate. |
| `operator` | string | MUST | Comparison operator: `>=`, `<=`, `==`, `!=`, `>`, `<`. |
| `threshold` | number | MUST | The threshold value. |

**Rule Object (tool-based):**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tool` | string | MUST | The analysis tool to run. |
| `maxSeverity` | string | MAY | Maximum allowed finding severity (e.g., `low`, `medium`, `high`, `critical`). |
| `rulesets` | array[string] | MAY | Rulesets to enable. |

**Rule Object (reviewer-based):**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `minimumReviewers` | integer | MUST | Minimum number of required reviewers. |
| `aiAuthorRequiresExtraReviewer` | boolean | MAY | Whether AI-authored code requires an additional reviewer. |

**Rule Object (documentation-based):**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `changedFilesRequireDocUpdate` | boolean | MUST | Whether changed files require documentation updates. |

**Rule Object (provenance-based):**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `requireAttribution` | boolean | MUST | Whether AI-generated code requires provenance attribution. |
| `requireHumanReview` | boolean | MAY | Whether a human review record is required. |

**Override Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `requiredRole` | string | MUST | The role authorized to override. |
| `requiresJustification` | boolean | MAY | Whether a justification text is required. Default: `true`. |

**Evaluation Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pipeline` | string | MAY | When to evaluate (e.g., `pre-merge`, `post-merge`, `continuous`). |
| `timeout` | string | MAY | Maximum evaluation duration. Format: duration string. |
| `retryPolicy` | RetryPolicy | MAY | Retry configuration for failed evaluations. |

**RetryPolicy Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `maxRetries` | integer | MAY | Maximum number of retries. |
| `backoff` | string | MAY | Backoff strategy: `linear`, `exponential`. |

#### 5.3.2 Status Fields

| Field | Type | Description |
| --- | --- | --- |
| `compliant` | boolean | Whether all gates are currently passing. |
| `conditions` | array[Condition] | Per-gate condition status. See [Section 6](#6-conditions). |

#### 5.3.3 Example

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: ai-code-standards
spec:
  scope:
    repositories: ["org/service-*"]
    authorTypes: ["ai-agent"]
  gates:
    - name: test-coverage
      enforcement: soft-mandatory
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
        requireAttribution: true
        requireHumanReview: true
  evaluation:
    pipeline: pre-merge
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

---

### 5.4 AutonomyPolicy

<!-- Source: PRD Section 8.4 -->

An [AutonomyPolicy](glossary.md#autonomy-policy) declares progressive [autonomy levels](glossary.md#autonomy-level) with quantitative [promotion](glossary.md#promotion) criteria and automatic [demotion](glossary.md#demotion) triggers. This is the most novel and differentiated resource type in the framework.

#### 5.4.1 Spec Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `levels` | array[Level] | MUST | Ordered list of autonomy levels (0-3). |
| `promotionCriteria` | map[string]PromotionCriteria | MUST | Keyed by transition (e.g., `0-to-1`). |
| `demotionTriggers` | array[DemotionTrigger] | MUST | Conditions that cause automatic demotion. |

**Level Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `level` | integer | MUST | Level number (0-3). |
| `name` | string | MUST | Human-readable name (e.g., "Intern", "Junior", "Senior", "Principal"). |
| `description` | string | MAY | Description of the level's scope. |
| `permissions` | Permissions | MUST | What the agent is allowed to do. |
| `guardrails` | Guardrails | MUST | Operational constraints. |
| `monitoring` | string | MUST | Monitoring intensity: `continuous`, `real-time-notification`, `audit-log`. |
| `minimumDuration` | string | MAY | Minimum time at this level before promotion. Format: duration string. Null for no minimum. |

**Permissions Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `read` | array[string] | MUST | Read permission scopes (glob patterns). |
| `write` | array[string] | MUST | Write permission scopes (action names or glob patterns). |
| `execute` | array[string] | MUST | Execute permission scopes (action names). |

**Guardrails Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `requireApproval` | string | MUST | Approval requirement: `all`, `security-critical-only`, `architecture-changes-only`, `none`. |
| `maxLinesPerPR` | integer | MAY | Maximum lines changed per pull request. |
| `blockedPaths` | array[string] | MAY | Glob patterns for paths the agent MUST NOT modify. |
| `transactionLimit` | string | MAY | Maximum cost/resource budget per time period. |

**PromotionCriteria Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `minimumTasks` | integer | MUST | Minimum tasks completed at current level. |
| `conditions` | array[MetricCondition] | MUST | Metric thresholds that must be met. |
| `requiredApprovals` | array[string] | MUST | Roles that must approve the promotion. |

**MetricCondition Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `metric` | string | MUST | The metric to evaluate. |
| `operator` | string | MUST | Comparison operator: `>=`, `<=`, `==`, `!=`, `>`, `<`. |
| `threshold` | number | MUST | The threshold value. |

**DemotionTrigger Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `trigger` | string | MUST | The event that triggers demotion. |
| `action` | string | MUST | The demotion action: `demote-to-0`, `demote-one-level`. |
| `cooldown` | string | MUST | Time before re-promotion is possible. Format: duration string. |

#### 5.4.2 Status Fields

| Field | Type | Description |
| --- | --- | --- |
| `agents` | array[AgentStatus] | Per-agent autonomy status. |

**AgentStatus Object:**

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Agent name (reference to AgentRole). |
| `currentLevel` | integer | Current autonomy level (0-3). |
| `promotedAt` | string (date-time) | When the agent was last promoted. |
| `nextEvaluationAt` | string (date-time) | When the next promotion evaluation occurs. |
| `metrics` | map[string]number | Current metric values for promotion evaluation. |

#### 5.4.3 Example

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
      minimumDuration: "2w"
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
      minimumDuration: null
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

---

### 5.5 AdapterBinding

<!-- Source: PRD Section 8.5 -->

An [AdapterBinding](glossary.md#adapter-binding) declares a tool integration as a swappable provider behind a uniform [interface contract](glossary.md#interface-contract).

#### 5.5.1 Spec Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `interface` | string | MUST | The abstract contract name (e.g., `IssueTracker`, `SourceControl`, `CIPipeline`, `CodeAnalysis`, `Messenger`, `DeploymentTarget`). |
| `type` | string | MUST | The concrete implementation (e.g., `linear`, `github`, `jira`). |
| `version` | string | MUST | Adapter version (SemVer). |
| `source` | string | MAY | Location of the adapter (registry URI, local path, or git reference). |
| `config` | object | MAY | Adapter-specific configuration. This field permits additional properties. |
| `healthCheck` | HealthCheck | MAY | Health check configuration. |

**HealthCheck Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `interval` | string | MAY | Time between health checks. Format: duration string. |
| `timeout` | string | MAY | Maximum time to wait for a health check response. Format: duration string. |

#### 5.5.2 Status Fields

| Field | Type | Description |
| --- | --- | --- |
| `connected` | boolean | Whether the adapter is currently connected. |
| `lastHealthCheck` | string (date-time) | Timestamp of the last successful health check. |
| `adapterVersion` | string | The running adapter version. |
| `specVersionSupported` | string | The spec version the adapter supports. |

#### 5.5.3 Example

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: linear-tracker
spec:
  interface: IssueTracker
  type: linear
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

## 6. Conditions

<!-- Source: PRD Section 7.1 -->

[Conditions](glossary.md#condition) represent individual aspects of a resource's observed state. They appear in the `status.conditions` array of any resource.

Every condition MUST contain the following fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string | MUST | The aspect of state this condition represents (e.g., `Healthy`, `TestCoverage`, `SecurityScan`). |
| `status` | string | MUST | One of: `True`, `False`, `Unknown`. |
| `reason` | string | MAY | A machine-readable reason code for the current status. |
| `message` | string | MAY | A human-readable description of the current status. |
| `lastTransitionTime` | string (date-time) | SHOULD | When the condition last transitioned from one status to another. |
| `lastEvaluated` | string (date-time) | MAY | When the condition was last evaluated. |

Conditions SHOULD be additive: new condition types MAY be added without removing existing ones. Implementations MUST NOT rely on the absence of a condition type to infer state; instead, `Unknown` SHOULD be used when a condition has not yet been evaluated.

---

## 7. Schema Validation

<!-- Source: PRD Section 7.2 -->

All resource types MUST define JSON Schema (draft 2020-12) definitions. Schemas are published at the base URL `https://ai-sdlc.io/schemas/v1alpha1/` and are available in the [schemas/](schemas/) directory of this repository.

Implementations MUST validate resources against their schema before admission. Specifically, implementations MUST:

1. **Reject unknown fields** — Resources with fields not defined in the schema MUST be rejected (equivalent to `additionalProperties: false`), except for fields explicitly marked as extensible (e.g., `AdapterBinding.spec.config`).
2. **Enforce required fields** — Resources missing required fields MUST be rejected.
3. **Validate types and formats** — Field values MUST conform to their declared type, pattern, and format constraints.
4. **Apply defaults** — Schema-defined default values SHOULD be applied to omitted optional fields.

Schema files are provided for all core resource types:

| Schema | Resource |
| --- | --- |
| [common.schema.json](schemas/common.schema.json) | Shared definitions (metadata, conditions, secretRef) |
| [pipeline.schema.json](schemas/pipeline.schema.json) | Pipeline |
| [agent-role.schema.json](schemas/agent-role.schema.json) | AgentRole |
| [quality-gate.schema.json](schemas/quality-gate.schema.json) | QualityGate |
| [autonomy-policy.schema.json](schemas/autonomy-policy.schema.json) | AutonomyPolicy |
| [adapter-binding.schema.json](schemas/adapter-binding.schema.json) | AdapterBinding |

---

## 8. Versioning

<!-- Source: PRD Section 17 -->

### 8.1 API Version Maturity

The specification follows a Kubernetes-style maturity progression:

| Stage | Format | Stability Guarantee | Breaking Changes |
| --- | --- | --- | --- |
| **Alpha** | `v1alpha1`, `v1alpha2` | No stability; may be removed without notice | Allowed between alpha versions |
| **Beta** | `v1beta1`, `v1beta2` | 9 months of support after deprecation | Allowed between beta versions |
| **GA** | `v1`, `v2` | 12 months of support after deprecation | Only between major versions |

The current specification version is `v1alpha1`. All resources MUST set `apiVersion` to `ai-sdlc.io/v1alpha1`.

### 8.2 Component-Level Stability

Individual components (adapters, policy templates, agent roles) carry their own stability level independent of the specification version. Stability levels follow the progression:

`Development` -> `Alpha` -> `Beta` -> `Stable` -> `Deprecated` -> `Removed`

Each component declares its stability in its `metadata.yaml` file. See [adapters.md](adapters.md#adapter-registration) for the metadata format.

### 8.3 Backward Compatibility

Within a given API version:

- New optional fields MAY be added to resource specs without a version bump
- Required fields MUST NOT be added without a new API version
- Existing field semantics MUST NOT change without a new API version
- Enum values MAY be added but MUST NOT be removed without a new API version

---

## 9. Reconciliation Semantics

<!-- Source: PRD Section 11 -->

The [reconciliation loop](glossary.md#reconciliation-loop) is the runtime heart of the AI-SDLC Framework. It follows the Kubernetes controller pattern: **desired state -> observe -> diff -> act -> loop**.

### 9.1 The Core Loop

```
1. DESIRED STATE — Read Pipeline, QualityGate, AutonomyPolicy resources
2. OBSERVE       — Watch development activity via adapters
3. DIFF          — Compare actual metrics against policy thresholds
4. ACT           — Enforce based on enforcement level
5. REMEDIATE     — Auto-heal (generate tests, assign reviewers, create tickets)
6. UPDATE STATUS — Write to resource status.conditions[]
7. REQUEUE       — Schedule next reconciliation (event-driven + periodic)
```

### 9.2 Required Properties

Implementations of the reconciliation engine MUST exhibit the following properties:

1. **Level-triggered, not edge-triggered** — Decisions MUST be based on the current state difference between `spec` and `status`, not on specific events that occurred. This ensures correct behavior regardless of missed events.

2. **Idempotent** — The same reconciliation MUST produce the same result regardless of how many times it is invoked. Implementations MUST NOT produce side effects that accumulate on repeated invocation.

3. **Eventually consistent** — The system MUST converge toward the desired state over time through repeated reconciliation cycles. Temporary inconsistency is acceptable.

4. **Rate-limited with backoff** — Implementations MUST rate-limit reconciliation cycles. On error, implementations MUST use exponential backoff. Work queues SHOULD deduplicate pending reconciliation requests for the same resource.

5. **Filtered** — Implementations MUST use predicates to ignore status-only updates. A controller's own status writes MUST NOT trigger re-reconciliation of the same resource (preventing infinite loops).

### 9.3 Reconciliation Results

Each reconciliation cycle MUST return one of:

| Result | Behavior |
| --- | --- |
| **Success** | Done until next event or periodic check |
| **Error** | Requeue with exponential backoff |
| **Explicit Requeue** | Immediate retry |
| **Delayed Requeue** | Check again after specified duration |

---

## 10. Extensibility

<!-- Source: PRD Section 5 (DP-4, DP-9) -->

### 10.1 Custom Resource Types

The AI-SDLC Framework follows a core-plus-extensions model. Implementations MAY support custom resource types beyond the five core types defined in this specification.

Custom resource types:

- MUST follow the same resource model (apiVersion, kind, metadata, spec, status)
- MUST provide a JSON Schema definition
- SHOULD use a custom `apiVersion` prefix (e.g., `extensions.ai-sdlc.io/v1alpha1`)
- MUST NOT use the `ai-sdlc.io` prefix for custom kinds

### 10.2 Extension Points

The following fields are designated as explicit extension points where additional properties are permitted:

- `AdapterBinding.spec.config` — Adapter-specific configuration (schema validation deferred to the adapter)
- `metadata.annotations` — Arbitrary non-identifying metadata
- `metadata.labels` — Arbitrary key-value pairs for selection

All other fields enforce `additionalProperties: false` to maintain schema strictness.

---

## 11. Conformance Levels

<!-- Source: PRD Section 18 -->

Implementations declare one of three [conformance levels](glossary.md#conformance-level):

| Level | Requirements |
| --- | --- |
| **Core** | Passes all core resource validation tests. Implements Pipeline and QualityGate resource types. Supports schema validation and the spec/status split. |
| **Adapter** | Meets Core requirements. Additionally passes adapter interface contract tests for at least one [interface contract](glossary.md#interface-contract). |
| **Full** | Meets Adapter requirements. Additionally passes all tests including autonomy level management, multi-agent orchestration, and reconciliation loop semantics. |

Conformance is verified through the language-agnostic conformance test suite in the [`conformance/`](../conformance/) directory. Implementations MUST document which conformance level they target and which spec version they support.
