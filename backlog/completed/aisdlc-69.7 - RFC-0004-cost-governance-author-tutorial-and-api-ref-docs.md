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
drift_status: flagged
drift_checked: '2026-05-03'
drift_log:
  - date: '2026-05-03'
    type: dep-resolved
    detail: Dependency AISDLC-69.2 has been completed
    resolution: flagged
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

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Authored RFC-0004 (Cost Governance and Attribution) tutorial + api-reference docs to satisfy the `requiresDocs` convention. Tutorial walks teams through CostPolicy, BudgetPolicy alerts, and `modelSelection.budgetPressure` (~1500 words, 6 sequential steps). API reference documents the full type surface with explicit `RFC-0004 §N` citations.

## Changes (parent repo)
- `docs/tutorials/cost-governance.md` (new, 235 lines)
- `docs/api-reference/cost.md` (new, 231 lines)
- `docs/tutorials/README.md` (added link)
- `docs/api-reference/README.md` (added link)
- `docs/operations/operator-runbook.md` (added cross-link)

## Sibling-repo state (NOT committed — operator action required)
Dev ran `pnpm docs:sync` which dirtied many .mdx files in `ai-sdlc-io/`. Task didn't declare `permittedExternalPaths`, so dev didn't commit. Operator must:
1. `git -C ../ai-sdlc-io reset --hard origin/main` (clean working tree)
2. Re-apply only the 5 RFC-0004 .mdx files from this PR's intent: `cost-governance.mdx`, `cost.mdx`, `tutorials/README.mdx`, `api-reference/README.mdx`, `operations/operator-runbook.mdx`
3. Open a sibling PR with just those 5

## AC status
- ✓ All 5 ACs met (rfc:check passes for RFC-0004 once it leaves Draft)

## Verification
- `pnpm rfc:check` clean
- `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
- 3 reviews approved: code 0c/0M/2m/2s; test 0c/0M/0m/0s; security 0c/0M/0m/0s
- ⚠ INDEPENDENCE NOT ENFORCED

## Coordination flags
- `docs/operations/operator-runbook.md` line ~441 conflicts with AISDLC-69.8 (both add Related Documents entries) — trivial 3-way resolve at merge time

## Follow-up (deferred, all minor)
- Tutorial Step 6 references `ai-sdlc validate`/`ai-sdlc dry-run` — aspirational subcommands not yet documented
- `cost.md:101` CostThreshold.currency marked `MUST` but description says "Defaults to USD if omitted" — clarify to `MUST (default USD)`
- `operator-runbook.md:261` says "`costBudget` semantics" but RFC-0004 defines `costPolicy.budget` (no `costBudget` field) — pre-existing wording, fix during 69.8 conflict resolution
- Tutorial uses bare `claude-sonnet-4-5` model identifier; RFC-0004 uses dated form `claude-sonnet-4-5-20250929`. Both valid; bare matches local convention
<!-- SECTION:FINAL_SUMMARY:END -->
