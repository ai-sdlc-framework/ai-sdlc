# AI-SDLC Policy Layer Specification

<!-- Source: PRD Section 10 -->

**Document type:** Normative
**Status:** Draft
**Spec version:** v1alpha1

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Enforcement Levels](#2-enforcement-levels)
3. [Evaluation Pipeline](#3-evaluation-pipeline)
4. [Policy Expression](#4-policy-expression)
5. [AI-Specific Quality Gate Extensions](#5-ai-specific-quality-gate-extensions)
6. [Override Semantics](#6-override-semantics)

---

## 1. Introduction

The policy layer defines how [quality gates](glossary.md#quality-gate) are enforced across the development lifecycle. It combines OPA/Gatekeeper's template/instance separation with HashiCorp Sentinel's three-tier [enforcement model](glossary.md#enforcement-level) and the CSA Agentic Trust Framework's progressive autonomy principles.

Quality gates are declared as [QualityGate](spec.md#53-qualitygate) resources and evaluated by the [reconciliation loop](glossary.md#reconciliation-loop) against observed development activity.

---

## 2. Enforcement Levels

<!-- Source: PRD Section 10.1 -->

Three enforcement levels provide graduated policy strictness. The enforcement level is **decoupled from policy logic** — the same rule operates at different enforcement levels depending on context.

### 2.1 Advisory

**Behavior:** The policy is evaluated but failure does not block the action.

- A warning MUST be logged
- A warning SHOULD be posted as a comment on the relevant artifact (e.g., PR comment)
- The dashboard MUST be updated to reflect the violation
- The action (merge, deploy, etc.) MUST be allowed to proceed

**Use cases:** New policies being validated, non-critical recommendations, team-level guidelines.

### 2.2 Soft-Mandatory

**Behavior:** The policy MUST pass unless an authorized user explicitly overrides.

- Failure MUST block the action
- An authorized user (as defined by the gate's `override.requiredRole`) MAY override the failure
- An override MUST require a justification when `override.requiresJustification` is `true` (the default)
- Every override MUST be recorded in the audit trail
- The dashboard MUST be updated to reflect both the violation and the override

**Use cases:** Standard quality gates, accountability with pragmatism, most day-to-day governance.

### 2.3 Hard-Mandatory

**Behavior:** The policy MUST pass. No override is possible.

- Failure MUST block the action
- No user, regardless of role, MAY override the failure
- The `override` field MUST be ignored for `hard-mandatory` gates
- The action MUST remain blocked until the underlying condition is resolved

**Use cases:** Security-critical gates, regulatory requirements, production safety controls.

---

## 3. Evaluation Pipeline

<!-- Source: PRD Section 10.2 -->

The enforcement pipeline mirrors the Kubernetes admission controller model. Every action (PR creation, merge request, deployment) passes through the following stages in order:

```
Request (PR, deploy, etc.)
  1. Authentication  — Who is the actor?
  2. Authorization   — Is this actor allowed this action?
  3. Mutating Gates  — Auto-enrich the request
  4. Validation      — Schema and structural checks
  5. Enforcing Gates — Evaluate quality gate rules
  6. Admission       — Proceed or block
```

### 3.1 Authentication

Implementations MUST identify the actor for every action. The actor identity MUST distinguish between:

- Human users
- AI agents (with specific [AgentRole](spec.md#52-agentrole) identity)
- Service accounts
- Automated systems (bots)

### 3.2 Authorization

Implementations MUST verify the actor has permission to perform the requested action. For AI agents, authorization MUST respect the agent's current [autonomy level](glossary.md#autonomy-level) and the permissions defined in the applicable [AutonomyPolicy](spec.md#54-autonomypolicy).

### 3.3 Mutating Gates

Mutating gates modify the request before validation. They MUST NOT reject requests. Mutating gates are used to auto-enrich actions:

- Add required labels or metadata
- Assign default reviewers
- Inject provenance information
- Apply organizational defaults

Mutating gates MUST be idempotent — applying the same mutation multiple times MUST produce the same result.

### 3.4 Validation

Structural validation ensures the request conforms to schema requirements. Validation MUST occur after mutation to validate the enriched request.

### 3.5 Enforcing Gates

Enforcing gates evaluate the quality gate rules defined in [QualityGate](spec.md#53-qualitygate) resources. Each gate is evaluated independently. Results are determined by [enforcement level](#2-enforcement-levels):

- `advisory` — Log and continue
- `soft-mandatory` — Block unless overridden
- `hard-mandatory` — Block unconditionally

When multiple gates apply to an action, ALL gates MUST pass (or be overridden, for `soft-mandatory`) for the action to be admitted. A single `hard-mandatory` failure blocks the entire action.

### 3.6 Admission

If all enforcing gates pass (or are overridden), the action is admitted. If any gate fails without override, the action is rejected with a structured error response listing all failed gates.

---

## 4. Policy Expression

<!-- Source: PRD Section 10.3 -->

Policies can be expressed in two forms:

### 4.1 Declarative YAML

For common patterns such as threshold checks, reviewer requirements, and label enforcement. This is the primary policy expression mechanism in the AI-SDLC Framework.

Declarative policies are defined inline in [QualityGate](spec.md#53-qualitygate) resources using the `rule` field. Implementations MUST support all rule types defined in the QualityGate schema:

- **Metric-based** — Compare a metric value against a threshold
- **Tool-based** — Run a tool and evaluate findings against severity limits
- **Reviewer-based** — Require a minimum number of reviewers
- **Documentation-based** — Require documentation updates for changed files
- **Provenance-based** — Require AI attribution and human review records

### 4.2 Rego / CEL (Advanced)

For policies requiring complex evaluation logic that cannot be expressed declaratively. Implementations MAY support:

- **Rego** (Open Policy Agent) — For cross-resource checks, temporal conditions, or custom scoring
- **CEL** (Common Expression Language) — For lightweight inline expressions

When advanced policy expressions are used, they SHOULD be referenced from the QualityGate resource rather than embedded inline. The mechanism for referencing external policy definitions is implementation-defined.

---

## 5. AI-Specific Quality Gate Extensions

<!-- Source: PRD Section 10.4 -->

Beyond standard CI/CD gates, the framework defines AI-specific quality gates that address risks unique to AI-generated code.

### 5.1 AI Attribution

Verify that code is correctly attributed as AI-generated and has been human-reviewed where required.

- Implementations MUST support the `requireAttribution` rule property
- When `requireAttribution` is `true`, AI-generated artifacts MUST include [provenance](glossary.md#provenance) metadata
- Attribution MUST include at minimum: model identifier, tool identifier, and timestamp

### 5.2 Provenance Tracking

Record the full lineage of every AI-generated artifact.

Required [provenance](glossary.md#provenance) fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | MUST | Model identifier (e.g., `claude-sonnet-4-5-20250929`). |
| `tool` | string | MUST | Tool that generated the artifact (e.g., `claude-code@1.2.0`). |
| `promptHash` | string | MUST | SHA-256 hash of the input prompt. |
| `timestamp` | string (date-time) | MUST | Generation time (ISO 8601). |
| `humanReviewer` | string | MAY | Identity of the human reviewer. |
| `reviewDecision` | string | MAY | One of: `approved`, `rejected`, `revised`. |

### 5.3 Stricter Initial Thresholds

AI-generated code MAY be subject to stricter quality requirements than human-written code. The `scope.authorTypes` field on QualityGate resources enables targeting gates specifically to AI-generated code.

Implementations SHOULD support applying different thresholds based on author type without requiring duplicate gate definitions.

### 5.4 LLM Evaluation

Gates MAY include LLM-based evaluation for AI outputs. This includes:

- Factuality checks
- Hallucination detection
- Relevance scoring

LLM evaluation gates SHOULD be configured with appropriate timeouts and fallback behavior, as they depend on external AI services.

### 5.5 Complexity-Routing Compliance

Gates MAY verify that a task was routed to the appropriate [autonomy tier](glossary.md#autonomy-level) based on its [complexity score](glossary.md#complexity-score). This ensures the [routing strategy](glossary.md#routing-strategy) is being followed.

---

## 6. Override Semantics

<!-- Source: PRD Section 10.1 -->

Overrides apply only to `soft-mandatory` gates. The override mechanism provides accountability while allowing pragmatism.

### 6.1 Authorization

Only users whose role matches the gate's `override.requiredRole` field MAY override a failing gate. Implementations MUST verify the user's role before accepting an override.

### 6.2 Justification

When `override.requiresJustification` is `true` (the default), the overriding user MUST provide a justification text. Implementations MUST reject overrides without justification when required.

### 6.3 Audit Trail

Every override MUST produce an immutable audit log entry containing:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `gate` | string | MUST | Name of the overridden gate. |
| `actor` | string | MUST | Identity of the overriding user. |
| `role` | string | MUST | Role of the overriding user. |
| `justification` | string | MUST | Justification text (when required). |
| `timestamp` | string (date-time) | MUST | When the override occurred. |
| `resource` | string | MUST | The resource affected by the override. |

### 6.4 Override Expiry

Overrides apply to a single evaluation. If the underlying condition persists, the gate will fail again on the next evaluation cycle and require a new override. Overrides MUST NOT be persistent or auto-renewing.
