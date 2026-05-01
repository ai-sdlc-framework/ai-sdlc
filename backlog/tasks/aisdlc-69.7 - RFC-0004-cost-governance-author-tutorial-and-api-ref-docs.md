---
id: AISDLC-69.7
title: RFC-0004 cost governance — author tutorial and api-ref docs
status: To Do
assignee: []
created_date: '2026-04-30 17:35'
updated_date: '2026-04-30 17:35'
labels:
  - docs
  - content
  - rfc-process
  - follow-up
  - aisdlc-69
dependencies:
  - AISDLC-69.2
references:
  - spec/rfcs/RFC-0004-cost-governance-and-attribution.md
  - docs/tutorials/
  - docs/api-reference/
  - docs/operations/operator-runbook.md
parent_task_id: AISDLC-69
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Sub-task of AISDLC-69. RFC-0004 (Cost Governance and Attribution) declares `requiresDocs: [tutorial, api-reference, operator-runbook]` per the convention defined in AISDLC-69.2. Current state of doc references:

- `docs/operations/operator-runbook.md` — already references RFC-0004 (covered).
- `docs/tutorials/` — **no file references RFC-0004** (gap).
- `docs/api-reference/` — **no file references RFC-0004** (gap).

CostPolicy, BudgetPolicy, the cost circuit breaker, model selection rules, and CostReceipt provenance fields are real, user-visible capabilities that need consumer-facing docs.

## What this task does

1. **Author `docs/tutorials/cost-governance.md`** — walkthrough showing a team setting `costPolicy.budget`, watching the budget alert at 60% / 80% / 100%, and tuning `agentRole.modelSelection.budgetPressure` to downshift on threshold. Include a worked YAML example. ≥ 600 words.
2. **Author `docs/api-reference/cost.md`** OR add a `## Cost Governance` section to an existing api-ref file (e.g. `core.md`). Document `CostPolicy`, `BudgetPolicy`, `ExecutionCostLimit`, `StageCostPolicy`, `AttributionPolicy`, `ModelPricingConfig`, `CostReceipt`, `CostBreakdown`, `ExecutionCostDetail`. Each must cite RFC-0004 explicitly.
3. (Optional but recommended) Cross-link the existing `operations/operator-runbook.md` cost section to the new tutorial.

Each new file/section MUST contain literal text `RFC-0004`.

After editing, run `pnpm docs:sync` so `ai-sdlc-io/content/docs/` stays in sync.

## Out of scope

- Implementing the CostReconciler, circuit breaker, or any code (separate engineering tasks).
- Cost dashboard / metrics implementation.
- Cross-provider cost normalization research (RFC-0004 §Open Questions).

## Acceptance Criteria
<!-- AC:BEGIN -->
1. At least one file under `docs/tutorials/` contains literal text `RFC-0004` and ≥ 600 words about cost governance.
2. At least one file under `docs/api-reference/` contains literal text `RFC-0004` and documents the `CostPolicy` / `BudgetPolicy` / `CostReceipt` API surface.
3. `docs/operations/operator-runbook.md` continues to reference RFC-0004 (no regression).
4. `pnpm docs:sync && pnpm docs:check` clean.
5. AISDLC-69.3's `pnpm docs:check` (or equivalent) passes for RFC-0004.
<!-- AC:END -->
<!-- SECTION:DESCRIPTION:END -->
