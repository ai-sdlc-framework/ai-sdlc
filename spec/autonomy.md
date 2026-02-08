# AI-SDLC Progressive Autonomy Specification

<!-- Source: PRD Section 12 -->

**Document type:** Normative
**Status:** Draft
**Spec version:** v1alpha1

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Autonomy Levels](#2-autonomy-levels)
3. [The Principle of Least Autonomy](#3-the-principle-of-least-autonomy)
4. [Complexity-Based Task Routing](#4-complexity-based-task-routing)
5. [Promotion Criteria](#5-promotion-criteria)
6. [Demotion Triggers](#6-demotion-triggers)
7. [Framework Alignment](#7-framework-alignment)

---

## 1. Introduction

The progressive autonomy system governs how much independence AI agents have within the development lifecycle. Autonomy is **earned through demonstrated reliability**, not granted by configuration alone. Every agent starts at a minimum [autonomy level](glossary.md#autonomy-level) and advances through quantitative evidence of trustworthiness.

Autonomy policies are declared as [AutonomyPolicy](spec.md#54-autonomypolicy) resources. The [reconciliation loop](glossary.md#reconciliation-loop) continuously evaluates agent behavior against promotion criteria and demotion triggers.

---

## 2. Autonomy Levels

<!-- Source: PRD Section 12.1 -->

The framework defines four autonomy levels (0-3). Each level specifies permissions, guardrails, and monitoring intensity.

### 2.1 Level 0 — Observer (Intern)

**Description:** Read-only observation. The agent observes the development process and learns patterns but produces no artifacts.

**Permissions:**
- Read: All accessible resources
- Write: None
- Execute: None

**Guardrails:**
- All actions require approval (effectively no actions are possible)

**Monitoring:** Continuous

**Minimum duration:** 2 weeks (RECOMMENDED)

### 2.2 Level 1 — Junior

**Description:** The agent recommends changes but every action requires mandatory human approval before execution.

**Permissions:**
- Read: All accessible resources
- Write: Draft pull requests, comments
- Execute: Test suites

**Guardrails:**
- All changes require human approval
- Maximum lines per PR: 200 (RECOMMENDED)
- Blocked from security-sensitive paths (RECOMMENDED)

**Monitoring:** Continuous

**Minimum duration:** 4 weeks (RECOMMENDED)

### 2.3 Level 2 — Senior

**Description:** The agent executes within defined guardrails with real-time notification to humans. Only security-critical changes require pre-approval.

**Permissions:**
- Read: All accessible resources
- Write: Branches, pull requests, comments
- Execute: Test suites, linters, builds

**Guardrails:**
- Only security-critical changes require pre-approval
- Maximum lines per PR: 500 (RECOMMENDED)
- Resource/cost budget limits SHOULD be enforced
- Reduced set of blocked paths

**Monitoring:** Real-time notification

**Minimum duration:** 8 weeks (RECOMMENDED)

### 2.4 Level 3 — Principal

**Description:** Autonomous within the agent's domain. Continuous validation replaces pre-approval. Audit trails provide accountability.

**Permissions:**
- Read: All accessible resources
- Write: Branches, pull requests, comments, merge non-critical changes
- Execute: Test suites, linters, builds, deploy to staging

**Guardrails:**
- Only architecture-level changes require pre-approval
- Maximum lines per PR: 1000 (RECOMMENDED)

**Monitoring:** Audit log

**Minimum duration:** None (continuous validation)

---

## 3. The Principle of Least Autonomy

<!-- Source: PRD Section 12.2 -->

Agents MUST operate at the **lowest autonomy level sufficient for their function**. This extends the cybersecurity Principle of Least Privilege to agent autonomy.

- Every agent MUST start at Level 0 or Level 1
- Agents MUST NOT be initialized at Level 2 or Level 3 without first demonstrating competence through the promotion process
- Implementations MUST enforce this by rejecting [AutonomyPolicy](spec.md#54-autonomypolicy) resources that set an agent's initial level above 1

---

## 4. Complexity-Based Task Routing

<!-- Source: PRD Section 12.3 -->

Task [complexity](glossary.md#complexity-score) determines the minimum autonomy level and human involvement required. Complexity is scored on a 1-10 scale.

### 4.1 Complexity Tiers

| Tier | Score | Strategy | Human Role |
| --- | --- | --- | --- |
| **Low** | 1-3 | `fully-autonomous` | None (post-hoc audit) |
| **Medium** | 4-6 | `ai-with-review` | Reviewer |
| **High** | 7-8 | `ai-assisted` | Collaborator |
| **Critical** | 9-10 | `human-led` | Owner |

### 4.2 Routing Strategies

**`fully-autonomous`** — The agent executes the task independently with automated quality gates. Human review occurs post-hoc through audit logs. This strategy MUST only be used for agents at Level 2 or Level 3.

**`ai-with-review`** — The agent generates the output (code, PR, etc.) and a human reviewer approves or requests changes before the output is accepted. This is the default strategy for Level 1 and Level 2 agents on medium-complexity tasks.

**`ai-assisted`** — A human leads the task with AI providing suggestions, drafts, and analysis. The human retains decision authority at every step.

**`human-led`** — A human performs the task with optional AI support for research, boilerplate generation, or documentation. The agent MUST NOT make autonomous changes.

### 4.3 Scoring

Complexity scoring MAY be performed by:
- Static analysis of the task description
- AI-based evaluation of task scope
- Manual assignment by a human
- Historical analysis of similar tasks

The scoring method is implementation-defined. However, the resulting score MUST be an integer in the range 1-10, and the routing strategy MUST be applied consistently based on the [Pipeline](spec.md#51-pipeline) resource's `routing.complexityThresholds` configuration.

---

## 5. Promotion Criteria

<!-- Source: PRD Section 12.4 -->

[Promotion](glossary.md#promotion) from one autonomy level to the next requires meeting quantitative criteria. Promotion criteria are declared in the [AutonomyPolicy](spec.md#54-autonomypolicy) resource's `promotionCriteria` field.

### 5.1 Requirements

Every promotion MUST satisfy:

1. **Minimum task count** — The agent MUST have completed at least `minimumTasks` tasks at the current level.
2. **Metric thresholds** — All metric conditions MUST be met simultaneously.
3. **Required approvals** — All roles listed in `requiredApprovals` MUST explicitly approve the promotion.
4. **Minimum duration** — If the current level specifies a `minimumDuration`, the agent MUST have spent at least that duration at the current level.

### 5.2 Recommended Metrics

The following metrics are RECOMMENDED for promotion evaluation:

| Metric | Description | Typical Threshold |
| --- | --- | --- |
| `recommendation-acceptance-rate` | Rate at which the agent's recommendations are accepted | >= 0.90 |
| `pr-approval-rate` | Rate at which the agent's PRs are approved | >= 0.90 (L1-L2), >= 0.95 (L2-L3) |
| `rollback-rate` | Rate of changes that required rollback | <= 0.02 (L1-L2), <= 0.01 (L2-L3) |
| `average-review-iterations` | Average number of review rounds per PR | <= 1.5 |
| `security-incidents` | Number of security incidents caused | == 0 |
| `code-coverage-maintained` | Whether code coverage is maintained or improved | >= 0.80 |
| `production-incidents-caused` | Number of production incidents caused | == 0 |

### 5.3 Evaluation

Implementations SHOULD evaluate promotion criteria periodically (e.g., weekly or on a configurable schedule). Evaluation MUST consider only tasks completed at the agent's current level — historical performance at previous levels MUST NOT be counted.

When all criteria are met, implementations SHOULD notify the required approvers and await explicit approval before advancing the agent's level.

---

## 6. Demotion Triggers

<!-- Source: PRD Section 12.4 -->

[Demotion](glossary.md#demotion) is automatic and immediate when a trigger event occurs. This ensures that trust is continuously verified.

### 6.1 Trigger Events

Demotion triggers are declared in the [AutonomyPolicy](spec.md#54-autonomypolicy) resource's `demotionTriggers` field. Common triggers include:

| Trigger | Recommended Action | Description |
| --- | --- | --- |
| `critical-security-incident` | `demote-to-0` | A security vulnerability was introduced or exploited |
| `rollback-rate-exceeds-5-percent` | `demote-one-level` | Rollback rate exceeded threshold over evaluation window |
| `unauthorized-access-attempt` | `demote-to-0` | Agent attempted to access a resource outside its permissions |

### 6.2 Demotion Actions

- **`demote-to-0`** — Immediately set the agent's autonomy level to 0 (Observer). Used for serious incidents.
- **`demote-one-level`** — Reduce the agent's autonomy level by one. Used for performance degradation.

### 6.3 Cooldown Period

After a demotion, a cooldown period MUST be observed before the agent is eligible for re-promotion. The cooldown duration is specified per trigger in the `cooldown` field.

During the cooldown period:
- The agent MUST operate at the demoted level
- Promotion criteria evaluation MUST NOT start until the cooldown expires
- Task counts for promotion MUST reset to zero

### 6.4 Notification

Implementations MUST notify relevant stakeholders when a demotion occurs. The notification MUST include:
- Agent identity
- Previous level and new level
- Trigger event that caused the demotion
- Cooldown duration
- Timestamp

---

## 7. Framework Alignment

<!-- Source: PRD Section 12.1 -->

The AI-SDLC autonomy system synthesizes three independently converging frameworks:

| AI-SDLC Level | CSA ATF Analog | Knight-Columbia Analog | Key Characteristic |
| --- | --- | --- | --- |
| 0 (Observer) | — | L1 Operator | Read-only; observe and learn |
| 1 (Junior) | Intern | L2 Collaborator | Recommend; all changes require approval |
| 2 (Senior) | Junior/Senior | L3 Consultant / L4 Approver | Execute within guardrails; real-time notification |
| 3 (Principal) | Principal | L5 Observer | Autonomous within domain; audit trail |

- **CSA Agentic Trust Framework** (February 2026) — Applies Zero Trust principles to AI agents. Trust is earned through demonstrated behavior and continuously verified through monitoring.
- **Knight-Columbia Autonomy Levels** (Feng, McDonald & Zhang, July 2025) — Frames autonomy as a deliberate design decision separate from capability.
- **Guided Autonomy / Principle of Least Autonomy** — Extends the cybersecurity Principle of Least Privilege to agent autonomy.
