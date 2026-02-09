# RFC-0002: Pipeline Orchestration Policy

**Status:** Draft
**Author:** AI-SDLC Contributors
**Created:** 2026-02-09
**Updated:** 2026-02-09
**Target Spec Version:** v1alpha1

---

## Summary

This RFC proposes extending the Pipeline resource with declarative orchestration semantics — stage lifecycle policies, branching strategies, approval integration, credential management, notification templates, and failure handling. Today, Pipeline declares *what* stages exist but leaves *how* they execute entirely to implementations, forcing every consumer to rewrite hundreds of lines of imperative orchestration logic. This extension closes that gap while preserving the spec's declarative, Kubernetes-aligned resource model.

## Motivation

The current Pipeline resource (spec.md §5.1) defines stages as a name + optional agent + optional quality gates. This is sufficient to describe *structure* but insufficient to describe *behavior*:

1. **Branching strategy** — The spec says nothing about how branches are created, named, or targeted. Every implementation hardcodes a pattern (e.g., `ai-sdlc/issue-{N}` targeting `main`).

2. **Stage failure handling** — When an agent fails or a quality gate denies, there is no spec-level guidance on whether to abort, retry, pause, or escalate. Implementations make incompatible choices.

3. **Approval integration** — AutonomyPolicy declares *what approval is required* per autonomy level, but not *when* in the pipeline flow approval is checked, whether it blocks, or what happens when pending.

4. **Credential lifecycle** — The spec has no model for JIT credentials scoped to agent execution. Implementations either skip credential management entirely or hardcode TTLs and scopes.

5. **Notification templates** — Every implementation hardcodes issue/PR comment templates. Two implementations of the same spec produce different user-facing messages with no way to standardize.

6. **PR creation conventions** — Title format, description structure, provenance inclusion, and close-on-merge keywords are all implementation-specific.

**Evidence from dogfooding:** The AI-SDLC dogfood pipeline (`dogfood/src/orchestrator/execute.ts`) contains ~600 lines of orchestration logic that is not captured by any spec resource. Of the 17 steps in its execution flow, only 2 (stage definition and complexity routing) are driven by Pipeline spec fields. The remaining 15 steps are hardcoded.

## Goals

- Define declarative orchestration semantics within the Pipeline resource's `spec.stages[]` objects
- Introduce a `branching` field for branch naming, target branch, and cleanup policy
- Introduce per-stage `onFailure` policies with retry, abort, pause, and escalate strategies
- Introduce an `approval` stage type that integrates with AutonomyPolicy approval tiers
- Introduce a `credentials` field for JIT credential scope and TTL per stage
- Introduce a `notifications` field for templated messages on pipeline events
- Introduce a `pullRequest` field for PR creation conventions
- Maintain full backward compatibility — all new fields are optional

## Non-Goals

- Turing-complete workflow language (conditionals, loops, variables) — that path leads to reimplementing Argo Workflows
- CI system-specific configuration (GitHub Actions YAML, GitLab CI syntax) — that belongs in AdapterBinding
- Agent prompt engineering or tool selection — that belongs in AgentRole
- Metric threshold definitions — that belongs in QualityGate and AutonomyPolicy
- Runtime implementation details (thread pools, queue mechanics, rate limits) — covered by reconciliation semantics (spec.md §9)

## Proposal

### 1. Extended Stage Object

<!-- Source: PRD Sections 8.1, 11 -->

The Stage object within `Pipeline.spec.stages[]` gains four new optional fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | MUST | Unique name within the pipeline. *(Existing, unchanged.)* |
| `agent` | string | MAY | Reference to an AgentRole resource name. *(Existing, unchanged.)* |
| `qualityGates` | array[string] | MAY | References to QualityGate resource names. *(Existing, unchanged.)* |
| `onFailure` | FailurePolicy | MAY | What to do when this stage fails. Defaults to `abort`. |
| `timeout` | string | MAY | Maximum duration for this stage (ISO 8601 duration, e.g., `PT10M`). |
| `credentials` | CredentialPolicy | MAY | JIT credential scope and lifetime for the stage's agent. |
| `approval` | ApprovalPolicy | MAY | Approval requirements before this stage executes. |

### 2. FailurePolicy Object

<!-- Source: PRD Section 11.3 -->

Declares the behavior when a stage fails (agent error, quality gate denial, or timeout).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `strategy` | string | MUST | One of: `abort`, `retry`, `pause`, `continue`. |
| `maxRetries` | integer | MAY | Maximum retry attempts. MUST be present when strategy is `retry`. Range: 1-10. |
| `retryDelay` | string | MAY | Delay between retries (ISO 8601 duration). Defaults to `PT30S`. |
| `notification` | string | MAY | Reference to a notification template name (from `Pipeline.spec.notifications`). |

**Strategy semantics:**

- **`abort`** — The pipeline transitions to `Failed` phase immediately. This is the default.
- **`retry`** — The stage is re-executed up to `maxRetries` times with `retryDelay` between attempts. If all retries fail, the pipeline transitions to `Failed`.
- **`pause`** — The pipeline transitions to `Suspended` phase and awaits manual intervention. The reconciliation loop MUST emit a `Delayed Requeue` result.
- **`continue`** — The stage failure is recorded in `status.conditions[]` but the pipeline proceeds to the next stage. This is appropriate for advisory-only stages (e.g., compliance reporting).

### 3. CredentialPolicy Object

<!-- Source: PRD Section 15.2 -->

Declares JIT credential requirements for a stage's agent execution.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `scope` | array[string] | MUST | Permission scopes for the credential (e.g., `["repo:read", "repo:write"]`). |
| `ttl` | string | MAY | Time-to-live for the credential (ISO 8601 duration). Defaults to `PT10M`. |
| `revokeOnComplete` | boolean | MAY | Whether to revoke the credential when the stage completes (success or failure). Defaults to `true`. |

Implementations MUST issue the credential before the stage's agent begins execution and MUST revoke it when `revokeOnComplete` is true, even if the stage fails. This maps to the JIT credential lifecycle in the security model.

### 4. ApprovalPolicy Object

<!-- Source: PRD Section 12.1 -->

Declares approval requirements that MUST be satisfied before a stage executes.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `required` | boolean | MUST | Whether approval is required for this stage. |
| `tierOverride` | string | MAY | Force a specific approval tier regardless of complexity routing. One of: `auto`, `peer-review`, `team-lead`, `security-review`. |
| `blocking` | boolean | MAY | Whether a `pending` approval status blocks pipeline execution. Defaults to `true`. |
| `timeout` | string | MAY | Maximum time to wait for approval before escalating (ISO 8601 duration). |
| `onTimeout` | string | MAY | Behavior when approval times out. One of: `abort`, `escalate`, `auto-approve`. Defaults to `abort`. |

When `blocking` is `true` and the approval status is `pending`, the pipeline MUST transition to `Suspended` phase and MUST NOT proceed to agent execution. The reconciliation loop SHOULD emit a `Delayed Requeue` to poll for approval status changes.

When `tierOverride` is not specified, the approval tier MUST be determined by the [complexity score](glossary.md#complexity-score) and the [routing strategy](glossary.md#routing-strategy) defined in `Pipeline.spec.routing`.

### 5. Branching Configuration

<!-- Source: PRD Section 8.1 -->

A new optional `branching` field on `Pipeline.spec`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | string | MUST | Branch name template. Supports `{issueNumber}`, `{agentName}`, `{timestamp}` placeholders. |
| `targetBranch` | string | MAY | Default target branch for PRs. Defaults to `main`. |
| `cleanup` | string | MAY | Branch cleanup policy. One of: `on-merge`, `on-close`, `manual`. Defaults to `on-merge`. |

Implementations MUST create branches matching the `pattern` template. The pattern is a simple string interpolation — not a regular expression or glob.

### 6. Pull Request Configuration

<!-- Source: PRD Section 14.3 -->

A new optional `pullRequest` field on `Pipeline.spec`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `titleTemplate` | string | MAY | PR title template. Supports `{issueTitle}`, `{issueNumber}`, `{type}` placeholders. Defaults to `"{type}: {issueTitle} (#{issueNumber})"`. |
| `descriptionSections` | array[string] | MAY | Ordered list of section names to include. Defaults to `["summary", "changes", "closes"]`. |
| `includeProvenance` | boolean | MAY | Whether to append a [provenance](glossary.md#provenance) block. Defaults to `true`. |
| `closeKeyword` | string | MAY | Keyword used to auto-close the linked issue. Defaults to `"Closes"`. |

The `type` placeholder in `titleTemplate` SHOULD be inferred from issue labels or agent output (e.g., `fix`, `feat`, `docs`). When inference is not possible, implementations SHOULD default to `fix`.

### 7. Notification Templates

A new optional `notifications` field on `Pipeline.spec`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `templates` | map[string]NotificationTemplate | MUST | Named templates referenced by stages and failure policies. |

**NotificationTemplate Object:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | string | MUST | Where to post the notification. One of: `issue`, `pr`, `both`. |
| `title` | string | MUST | Notification heading. Supports `{prefix}`, `{stageName}`, `{issueNumber}`, `{prNumber}` placeholders. |
| `body` | string | MAY | Notification body template. Supports the same placeholders plus `{details}` for stage-specific content. |

Implementations MUST render template placeholders before posting. Unknown placeholders SHOULD be left as-is rather than causing errors.

---

## Design Details

### Schema Changes

The following additions to `pipeline.schema.json` are required:

```json
{
  "properties": {
    "spec": {
      "properties": {
        "branching": {
          "type": "object",
          "properties": {
            "pattern": {
              "type": "string",
              "description": "Branch name template with {issueNumber}, {agentName}, {timestamp} placeholders."
            },
            "targetBranch": {
              "type": "string",
              "default": "main",
              "description": "Default target branch for pull requests."
            },
            "cleanup": {
              "type": "string",
              "enum": ["on-merge", "on-close", "manual"],
              "default": "on-merge",
              "description": "Branch cleanup policy after PR lifecycle."
            }
          },
          "required": ["pattern"]
        },
        "pullRequest": {
          "type": "object",
          "properties": {
            "titleTemplate": {
              "type": "string",
              "default": "{type}: {issueTitle} (#{issueNumber})"
            },
            "descriptionSections": {
              "type": "array",
              "items": { "type": "string" },
              "default": ["summary", "changes", "closes"]
            },
            "includeProvenance": {
              "type": "boolean",
              "default": true
            },
            "closeKeyword": {
              "type": "string",
              "default": "Closes"
            }
          }
        },
        "notifications": {
          "type": "object",
          "properties": {
            "templates": {
              "type": "object",
              "additionalProperties": {
                "$ref": "#/$defs/NotificationTemplate"
              }
            }
          }
        }
      }
    }
  },
  "$defs": {
    "FailurePolicy": {
      "type": "object",
      "properties": {
        "strategy": {
          "type": "string",
          "enum": ["abort", "retry", "pause", "continue"]
        },
        "maxRetries": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10
        },
        "retryDelay": {
          "type": "string",
          "default": "PT30S",
          "description": "ISO 8601 duration between retry attempts."
        },
        "notification": {
          "type": "string",
          "description": "Reference to a notification template name."
        }
      },
      "required": ["strategy"],
      "if": { "properties": { "strategy": { "const": "retry" } } },
      "then": { "required": ["maxRetries"] }
    },
    "CredentialPolicy": {
      "type": "object",
      "properties": {
        "scope": {
          "type": "array",
          "items": { "type": "string" },
          "minItems": 1
        },
        "ttl": {
          "type": "string",
          "default": "PT10M",
          "description": "ISO 8601 duration for credential lifetime."
        },
        "revokeOnComplete": {
          "type": "boolean",
          "default": true
        }
      },
      "required": ["scope"]
    },
    "ApprovalPolicy": {
      "type": "object",
      "properties": {
        "required": { "type": "boolean" },
        "tierOverride": {
          "type": "string",
          "enum": ["auto", "peer-review", "team-lead", "security-review"]
        },
        "blocking": {
          "type": "boolean",
          "default": true
        },
        "timeout": {
          "type": "string",
          "description": "ISO 8601 duration to wait for approval."
        },
        "onTimeout": {
          "type": "string",
          "enum": ["abort", "escalate", "auto-approve"],
          "default": "abort"
        }
      },
      "required": ["required"]
    },
    "NotificationTemplate": {
      "type": "object",
      "properties": {
        "target": {
          "type": "string",
          "enum": ["issue", "pr", "both"]
        },
        "title": { "type": "string" },
        "body": { "type": "string" }
      },
      "required": ["target", "title"]
    }
  }
}
```

### Behavioral Changes

#### Reconciliation Loop Impact

The reconciliation loop (spec.md §9) behavior is extended as follows:

1. **Stage transitions** — When the reconciler advances to a new stage, it MUST check the stage's `approval` policy before proceeding. If approval is required and `blocking` is true, the pipeline MUST transition to `Suspended` phase.

2. **Failure handling** — When a stage fails, the reconciler MUST consult the stage's `onFailure` policy rather than unconditionally failing the pipeline. The `retry` strategy MUST respect `maxRetries` and `retryDelay`. The `pause` strategy MUST set `status.phase` to `Suspended`.

3. **Credential lifecycle** — When a stage has a `credentials` policy, the reconciler MUST issue credentials before invoking the agent and MUST revoke them when the stage completes (if `revokeOnComplete` is true). Revocation MUST happen even on stage failure.

4. **Timeout enforcement** — When a stage has a `timeout` field, the reconciler MUST monitor stage duration. If the timeout expires, the stage is treated as failed and the `onFailure` policy applies.

#### New Status Fields

Two new fields are added to `Pipeline.status`:

| Field | Type | Description |
| --- | --- | --- |
| `stageAttempts` | map[string]integer | Number of execution attempts per stage (relevant for retry policies). |
| `pendingApproval` | ApprovalStatus | Details of a pending approval when phase is `Suspended`. |

**ApprovalStatus Object:**

| Field | Type | Description |
| --- | --- | --- |
| `stage` | string | The stage awaiting approval. |
| `tier` | string | The approval tier required. |
| `requestedAt` | string | ISO 8601 timestamp of approval request. |
| `timeoutAt` | string | ISO 8601 timestamp when approval times out (if timeout is set). |

### Migration Path

All new fields are optional with sensible defaults. Existing Pipeline resources validate without modification:

- Missing `branching` → implementation uses its own convention (current behavior)
- Missing `onFailure` → defaults to `abort` (current behavior for most implementations)
- Missing `credentials` → no JIT credential management (current behavior)
- Missing `approval` → no stage-level approval check (current behavior)
- Missing `pullRequest` → implementation uses its own conventions (current behavior)
- Missing `notifications` → implementation uses hardcoded templates (current behavior)

---

## Backward Compatibility

- **Not a breaking change.** All new fields are optional.
- Existing Pipeline resources validate against the updated schema without modification.
- Implementations that do not support the new fields MAY ignore them, though they SHOULD log a warning when an unsupported field is present.
- No changes to the existing five top-level fields (apiVersion, kind, metadata, spec, status).

---

## Alternatives Considered

### Alternative 1: Separate PipelineOrchestrationPolicy Resource

Instead of extending Pipeline, create a new 6th resource type that references a Pipeline and adds orchestration semantics.

**Rejected because:** This violates the spec's principle that a Pipeline "defines a complete SDLC workflow from trigger through delivery" (spec.md §5.1). Orchestration *is* part of the workflow definition. Splitting it into a separate resource creates a confusing ownership boundary and requires cross-resource validation.

### Alternative 2: Turing-Complete Workflow DSL

Introduce conditionals (`if`), loops (`while`), variables, and expressions within Pipeline stages — essentially a YAML-based programming language.

**Rejected because:** This dramatically increases specification complexity, makes schema validation intractable, and creates a "YAML programming" anti-pattern. The spec should declare *what happens* and *under what policy*, not provide a general-purpose execution engine. Implementations that need complex branching logic can use their own orchestration layer (Argo, Tekton, etc.) as the runtime.

### Alternative 3: Convention-Only (No Spec Change)

Document recommended conventions in a non-normative primer instead of adding them to the schema.

**Rejected because:** The dogfood experience demonstrates that orchestration decisions are not "nice to have" — they are the core of pipeline execution. Without normative requirements, two implementations of the same Pipeline resource will produce materially different behavior (different branch names, different PR formats, different failure handling). This undermines the spec's goal of portable, declarative pipeline definitions.

### Alternative 4: Embed Orchestration in AdapterBinding

Make branching, PR creation, and notification templates part of adapter configuration rather than Pipeline spec.

**Rejected because:** These are pipeline-level concerns, not adapter-level concerns. The same adapter (e.g., GitHub SourceControl) should work with different branching strategies depending on the pipeline. Embedding orchestration in adapters would prevent adapter reuse across pipelines.

---

## Examples

### Complete Pipeline with Orchestration

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

  branching:
    pattern: "ai-sdlc/issue-{issueNumber}"
    targetBranch: main
    cleanup: on-merge

  pullRequest:
    titleTemplate: "{type}: {issueTitle} (#{issueNumber})"
    descriptionSections: ["summary", "changes", "closes"]
    includeProvenance: true
    closeKeyword: "Closes"

  notifications:
    templates:
      gate-failure:
        target: issue
        title: "AI-SDLC: Quality Gate Failed"
        body: "This issue did not pass quality gate checks:\n\n{details}"
      agent-failure:
        target: issue
        title: "AI-SDLC: Agent Failed"
        body: "The agent encountered an error during {stageName}:\n\n{details}"
      pr-created:
        target: issue
        title: "AI-SDLC: PR Created"
        body: "Pull request created: {prUrl}\n\nFiles changed: {filesChanged}\n\nPlease review and merge."
      fix-ci-limit:
        target: pr
        title: "AI-SDLC: Retry Limit Reached"
        body: "This PR has reached the maximum number of automated fix attempts. Manual intervention is needed."

  stages:
    - name: validate
      qualityGates: [issue-quality]
      onFailure:
        strategy: abort
        notification: gate-failure

    - name: approve
      approval:
        required: true
        blocking: true
        timeout: PT24H
        onTimeout: escalate

    - name: implement
      agent: coding-agent
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

    - name: validate-output
      qualityGates: [code-quality, security-scan]
      onFailure:
        strategy: abort
        notification: gate-failure

    - name: compliance
      qualityGates: [compliance-check]
      onFailure:
        strategy: continue

  routing:
    complexityThresholds:
      low: { min: 1, max: 3, strategy: "fully-autonomous" }
      medium: { min: 4, max: 6, strategy: "ai-with-review" }
      high: { min: 7, max: 8, strategy: "ai-assisted" }
      critical: { min: 9, max: 10, strategy: "human-led" }

status:
  phase: Running
  activeStage: implement
  stageAttempts:
    validate: 1
    implement: 2
  conditions:
    - type: Healthy
      status: "True"
      lastTransitionTime: "2026-02-09T10:00:00Z"
```

### Minimal Pipeline (Backward Compatible)

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: simple-pipeline
  namespace: team-beta
spec:
  triggers:
    - event: issue.assigned
  providers:
    sourceControl:
      type: github
      config: { org: "team-beta" }
  stages:
    - name: implement
      agent: code-agent
      qualityGates: [basic-checks]
```

This minimal pipeline is valid under both the current and proposed schemas. All orchestration fields use their defaults: `onFailure: abort`, no approval, no credentials, implementation-defined branching and PR conventions.

---

## Implementation Plan

- [ ] Update normative spec document (`spec.md` §5.1 Pipeline)
- [ ] Update JSON Schema (`pipeline.schema.json`)
- [ ] Add new glossary terms: [Failure Policy](#failure-policy), [Credential Policy](#credential-policy), [Approval Policy](#approval-policy-stage), [Notification Template](#notification-template)
- [ ] Update primer (`primer.md`) with orchestration concepts and examples
- [ ] Reference implementation: extend `Pipeline` type definitions and `enforce`/reconciliation logic
- [ ] Dogfood: refactor `execute.ts` to read orchestration config from Pipeline resource instead of hardcoding
- [ ] Conformance test updates: add orchestration-related test cases
- [ ] Update `adapters.md` to clarify boundary between adapter config and pipeline orchestration

## Open Questions

1. **Stage dependencies vs. strict ordering** — Should stages support a `dependsOn` field for DAG-style execution, or is the current sequential ordering sufficient? Sequential ordering covers the common case. DAG support adds significant complexity and may be better deferred to a future RFC.

2. **Notification template language** — Is simple `{placeholder}` interpolation sufficient, or do templates need conditionals (e.g., "show reviewer name if present")? The proposal starts with simple interpolation; a future RFC could introduce a lightweight template language if needed.

3. **Approval escalation semantics** — When `onTimeout: escalate` is specified, what does "escalate" mean concretely? The proposal leaves this to implementations (e.g., notify a higher-level approver, post to a Slack channel). Should the spec define escalation targets?

4. **Fix-CI as a separate pipeline or stage** — The dogfood pipeline has a distinct fix-CI flow (`fix-ci.ts`) that is triggered by CI failures, not by issue assignment. Should the spec model this as a separate Pipeline resource triggered by `ci.failed`, or as a retry strategy within the `implement` stage? The current proposal models it via `onFailure.strategy: retry`, but the fix-CI flow has distinct logic (fetching CI logs, passing error context to agent).

5. **Credential scope standardization** — Should the spec define a standard set of scope strings (e.g., `repo:read`, `repo:write`, `ci:trigger`), or leave them adapter-specific? Standardizing enables portable policies but may not cover all adapter capabilities.

## References

- [spec.md §5.1 Pipeline](../spec.md#51-pipeline) — Current Pipeline resource definition
- [spec.md §9 Reconciliation Semantics](../spec.md#9-reconciliation-semantics) — Core reconciliation loop
- [autonomy.md](../autonomy.md) — Autonomy levels and approval requirements
- [policy.md](../policy.md) — Quality gate enforcement levels
- [adapters.md](../adapters.md) — Adapter interface contracts
- [PRD §8.1](../../research/ai-sdlc-framework-prd.md) — Pipeline resource requirements
- [PRD §11](../../research/ai-sdlc-framework-prd.md) — Runtime reconciliation engine
- [PRD §12](../../research/ai-sdlc-framework-prd.md) — Progressive autonomy system
- [PRD §15](../../research/ai-sdlc-framework-prd.md) — Security model
- [Argo Workflows](https://argoproj.github.io/workflows/) — Prior art for declarative workflow orchestration
- [Tekton Pipelines](https://tekton.dev/) — Prior art for Kubernetes-native CI/CD pipelines
- [GitHub Actions](https://docs.github.com/en/actions) — Prior art for event-driven pipeline execution
