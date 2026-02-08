# AI-SDLC Metrics and Observability Specification

<!-- Source: PRD Section 14 -->

**Document type:** Normative
**Status:** Draft
**Spec version:** v1alpha1

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Metric Categories](#2-metric-categories)
3. [OpenTelemetry Integration](#3-opentelemetry-integration)
4. [Provenance Tracking](#4-provenance-tracking)
5. [Audit Trail Requirements](#5-audit-trail-requirements)

---

## 1. Introduction

Beyond DORA's four keys, AI-augmented development requires purpose-built measurements. This document defines the AI-SDLC metrics framework, OpenTelemetry integration conventions, provenance tracking requirements, and audit trail specifications.

Metrics serve two purposes in the AI-SDLC Framework:
1. **Governance** — Metrics drive [promotion](glossary.md#promotion) and [demotion](glossary.md#demotion) decisions in the [autonomy system](autonomy.md)
2. **Observability** — Metrics provide visibility into the health and performance of AI-augmented development workflows

---

## 2. Metric Categories

<!-- Source: PRD Section 14.1 -->

The framework defines five metric categories. Implementations MUST support collecting and reporting metrics from at least the first three categories (Task Effectiveness, Human-in-Loop, Code Quality).

### 2.1 Task Effectiveness

Metrics measuring how effectively agents complete assigned tasks.

| Metric | Name | Type | Unit | Description |
| --- | --- | --- | --- | --- |
| `ai_sdlc.task.success_rate` | Agent success rate | Gauge | Ratio (0-1) | Tasks completed successfully / tasks assigned |
| `ai_sdlc.task.completion_time` | Task completion time | Histogram | Seconds | Time from task assignment to completion |
| `ai_sdlc.task.time_vs_baseline` | Time vs. human baseline | Gauge | Ratio | Agent completion time / human baseline for equivalent tasks |
| `ai_sdlc.task.resolution_time` | Time-to-resolution | Histogram | Seconds | Time from task creation to resolution, by complexity tier |

**Dimensions:**
- `agent` — Agent name (AgentRole reference)
- `complexity_tier` — low, medium, high, critical
- `task_type` — implementation, review, testing, deployment

### 2.2 Human-in-Loop Indicators

Metrics measuring the frequency and nature of human involvement.

| Metric | Name | Type | Unit | Description |
| --- | --- | --- | --- | --- |
| `ai_sdlc.human.intervention_rate` | Human intervention rate | Gauge | Ratio (0-1) | Tasks requiring human intervention / total tasks |
| `ai_sdlc.human.escalation_count` | Escalation frequency | Counter | Count | Number of escalations from agent to human |
| `ai_sdlc.human.override_rate` | Override rate | Gauge | Ratio (0-1) | Quality gate overrides / total evaluations |

**Dimensions:**
- `agent` — Agent name
- `autonomy_level` — 0, 1, 2, 3
- `reason` — Reason for intervention/escalation

### 2.3 Code Quality

Metrics measuring the quality of AI-generated code.

| Metric | Name | Type | Unit | Description |
| --- | --- | --- | --- | --- |
| `ai_sdlc.code.acceptance_rate` | Acceptance rate | Gauge | Ratio (0-1) | PRs accepted without modification / total PRs. Baseline: 0.27-0.30 |
| `ai_sdlc.code.defect_density` | Defect density | Gauge | Defects/KLOC | Defects per thousand lines of code, by author type |
| `ai_sdlc.code.churn_rate` | Churn rate | Gauge | Ratio (0-1) | Lines changed within 14 days of initial commit / total lines. AI baseline: ~0.41 higher than human |
| `ai_sdlc.code.security_pass_rate` | Security scan pass rate | Gauge | Ratio (0-1) | PRs passing security scan / total PRs, by author type |

**Dimensions:**
- `author_type` — ai-agent, human
- `agent` — Agent name (when author_type is ai-agent)
- `language` — Programming language
- `repository` — Repository identifier

### 2.4 Economic Efficiency

Metrics measuring the cost-effectiveness of AI agent usage.

| Metric | Name | Type | Unit | Description |
| --- | --- | --- | --- | --- |
| `ai_sdlc.cost.per_task` | Cost per task | Histogram | USD | Total cost per task (tokens + compute + human review time) |
| `ai_sdlc.cost.model_usage_mix` | Model usage mix | Gauge | Ratio (0-1) | Percentage of tasks using each model tier (cheap vs. expensive) |
| `ai_sdlc.cost.cache_hit_rate` | Cache hit rate | Gauge | Ratio (0-1) | Cache hits / total requests to AI services |
| `ai_sdlc.cost.tco_per_feature` | TCO per feature | Histogram | USD | Total cost of ownership per feature delivered |

**Dimensions:**
- `model` — Model identifier
- `agent` — Agent name
- `team` — Team/namespace

### 2.5 Autonomy Trajectory

Metrics tracking the progression of agent autonomy over time.

| Metric | Name | Type | Unit | Description |
| --- | --- | --- | --- | --- |
| `ai_sdlc.autonomy.level` | Autonomy level | Gauge | Level (0-3) | Current autonomy level per agent |
| `ai_sdlc.autonomy.complexity_handled` | Complexity handled | Histogram | Score (1-10) | Distribution of task complexity scores handled at each level |
| `ai_sdlc.autonomy.intervention_trend` | Intervention rate trend | Gauge | Ratio (0-1) | Rolling average of intervention rate (should decrease over time) |
| `ai_sdlc.autonomy.time_to_promotion` | Time-to-promotion | Gauge | Seconds | Time spent at current level before promotion |

**Dimensions:**
- `agent` — Agent name
- `from_level` — Previous level (for promotions)
- `to_level` — New level (for promotions)

---

## 3. OpenTelemetry Integration

<!-- Source: PRD Section 14.2 -->

The framework SHOULD define semantic conventions for AI-SDLC observability, extending OpenTelemetry's GenAI semantic conventions. All metric, trace, and log attribute names MUST use the `ai_sdlc.*` namespace prefix.

### 3.1 Traces

Implementations SHOULD generate spans for the following operations:

| Span Name | Description | Attributes |
| --- | --- | --- |
| `ai_sdlc.pipeline.stage` | One span per pipeline stage execution | `pipeline`, `stage`, `agent` |
| `ai_sdlc.agent.task` | One span per agent task execution | `agent`, `task_type`, `complexity` |
| `ai_sdlc.gate.evaluation` | One span per quality gate evaluation | `gate`, `enforcement`, `result` |
| `ai_sdlc.reconciliation.cycle` | One span per reconciliation cycle | `resource_kind`, `resource_name`, `result` |
| `ai_sdlc.handoff` | One span per agent handoff | `source_agent`, `target_agent`, `contract_id` |

Spans SHOULD be linked into traces following the pipeline execution flow:

```
pipeline.stage (implement)
  └─→ agent.task (code-agent)
       ├─→ gate.evaluation (test-coverage)
       └─→ gate.evaluation (security-scan)
  └─→ handoff (code-agent → reviewer-agent)
pipeline.stage (review)
  └─→ agent.task (reviewer-agent)
       └─→ gate.evaluation (human-review)
```

### 3.2 Metrics

Implementations MUST expose metrics using the names and types defined in [Section 2](#2-metric-categories). Metrics SHOULD be exportable via OpenTelemetry Protocol (OTLP).

**Instrument types:**
- **Gauge** — For values that can go up and down (e.g., autonomy level, rates)
- **Counter** — For values that only increase (e.g., escalation count)
- **Histogram** — For distributions (e.g., task completion time, cost per task)

### 3.3 Logs

Implementations MUST produce structured logs for the following events:

| Event | Required Fields | Description |
| --- | --- | --- |
| `reconciliation.decision` | resource, action, reason, result | Every reconciliation decision |
| `autonomy.promotion` | agent, from_level, to_level, criteria_met | Agent promoted |
| `autonomy.demotion` | agent, from_level, to_level, trigger | Agent demoted |
| `gate.override` | gate, actor, role, justification | Quality gate overridden |
| `gate.failure` | gate, enforcement, reason | Quality gate failed |
| `handoff.completed` | source, target, contract, validation_result | Agent handoff completed |

Logs MUST be structured (JSON) and SHOULD be exportable via OTLP.

---

## 4. Provenance Tracking

<!-- Source: PRD Section 14.3 -->

Every AI-generated artifact MUST record [provenance](glossary.md#provenance) metadata. Provenance enables attribution, auditability, and regulatory compliance.

### 4.1 Required Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | MUST | Model identifier (e.g., `claude-sonnet-4-5-20250929`). |
| `tool` | string | MUST | Tool that generated the artifact (e.g., `claude-code@1.2.0`). |
| `promptHash` | string | MUST | SHA-256 hash of the input prompt. |
| `timestamp` | string (date-time) | MUST | ISO 8601 generation time. |
| `humanReviewer` | string | MAY | Identity of the human who reviewed the artifact. |
| `reviewDecision` | string | MAY | One of: `approved`, `rejected`, `revised`. |

### 4.2 Storage

Provenance metadata SHOULD be stored:
- In commit metadata (git trailers or notes)
- In PR descriptions or comments
- In a dedicated provenance store accessible via API

Implementations MUST ensure provenance records are immutable after creation.

### 4.3 Attribution

When [QualityGate](spec.md#53-qualitygate) rules include `requireAttribution: true`, implementations MUST verify that provenance metadata is present and complete before admitting the artifact.

---

## 5. Audit Trail Requirements

<!-- Source: PRD Section 15.4 -->

Every action in the system MUST produce an immutable, tamper-evident audit log entry.

### 5.1 Required Audit Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | MUST | Unique audit entry identifier. |
| `timestamp` | string (date-time) | MUST | When the action occurred. |
| `actor` | string | MUST | Identity of the actor (human or agent). |
| `actorType` | string | MUST | One of: `human`, `ai-agent`, `bot`, `service-account`. |
| `action` | string | MUST | Action performed (e.g., `create`, `update`, `approve`, `override`, `promote`, `demote`). |
| `resource` | string | MUST | Resource affected (kind/namespace/name). |
| `policyEvaluated` | string | MAY | Policy or gate that was evaluated. |
| `decision` | string | MUST | Decision rendered (e.g., `allowed`, `denied`, `overridden`). |
| `details` | object | MAY | Additional context (justification, metric values, etc.). |

### 5.2 Immutability

Audit log entries MUST NOT be modifiable after creation. Implementations SHOULD use append-only storage with integrity verification (e.g., hash chains, write-once storage).

### 5.3 Retention

Implementations SHOULD support configurable retention policies for audit logs. The default retention period SHOULD be at least 12 months to support regulatory compliance.

### 5.4 Access

Audit logs MUST be accessible to authorized users via API. Implementations SHOULD support filtering by actor, action, resource, and time range.
