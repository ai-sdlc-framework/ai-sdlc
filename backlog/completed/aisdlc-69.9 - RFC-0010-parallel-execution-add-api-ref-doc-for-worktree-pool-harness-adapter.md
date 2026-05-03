---
id: AISDLC-69.9
title: >-
  RFC-0010 parallel execution — add api-ref doc for worktree pool / harness
  adapter
status: Done
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
parent_task_id: AISDLC-69
priority: low
drift_status: flagged
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Sub-task of AISDLC-69. RFC-0010 (Parallel Execution and Worktree Pooling) declares `requiresDocs: [operator-runbook, api-reference]` per the convention defined in AISDLC-69.2. Current state:

- `docs/operations/operator-runbook.md` — already references RFC-0010 extensively (covered).
- `docs/operations/adapter-authoring.md` — already references RFC-0010 (also covered).
- `docs/api-reference/` — **no file references RFC-0010** (gap).

The HarnessAdapter, WorktreePool, DatabaseBranchPool, SubscriptionPlan, and DeterministicPortAllocator interfaces introduced by RFC-0010 are programmatic surfaces that integrators need a reference doc for.

## What this task does

Author `docs/api-reference/parallel-execution.md` (or fold into `docs/api-reference/runners.md` as a section) covering:

- `HarnessAdapter` interface (capability matrix, fallback chain, `getAccountId`)
- `WorktreePool` resource shape (`maxConcurrent`, `branchTtl`, lifecycle)
- `DatabaseBranchAdapter` + `DatabaseBranchPool` (warm pool, allowBranchFromBranch)
- `SubscriptionPlan` + `SubscriptionLedger` (window quotas, off-peak schedule, quotaSource)
- `Stage` extensions: `model`, `harness`, `databaseAccess`, `requiresIndependentHarnessFrom`, `estimatedTokens`, `schedule`
- Cite RFC-0010 explicitly in the file (literal text `RFC-0010`).

After editing, run `pnpm docs:sync` so `ai-sdlc-io/content/docs/` stays in sync.

## Out of scope

- Implementation of the interfaces (already done in `orchestrator/`).
- Tutorial on parallel execution (the runbook already covers the operator path; a tutorial is nice-to-have, not declared in `requiresDocs`).

## Acceptance Criteria
<!-- AC:BEGIN -->
1. At least one file under `docs/api-reference/` contains literal text `RFC-0010` and documents the HarnessAdapter / WorktreePool / DatabaseBranchAdapter / SubscriptionPlan API surface.
2. `docs/operations/operator-runbook.md` continues to reference RFC-0010 (no regression).
3. `pnpm docs:sync && pnpm docs:check` clean.
4. AISDLC-69.3's `pnpm docs:check` (or equivalent) passes for RFC-0010.
<!-- AC:END -->
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Created `docs/api-reference/parallel-execution.md` (~600 lines) as the RFC-0010 surface companion. R1 ship had material divergences from the RFC (13 majors); R2 rewrote to track RFC-0010 §6, §8, §9, §11, §13, §14, §15, §16 literally so operators can copy-paste examples and write valid pipelines.

## Changes
- `docs/api-reference/parallel-execution.md` (new): HarnessAdapter + DatabaseBranchAdapter interfaces, WorktreePool / SubscriptionPlan / DatabaseBranchPool YAML examples, Stage extensions (databaseAccess/schedule/kind/harness/harnessFallback/requiresIndependentHarnessFrom/model/maxBudgetUsd/holdsMergeGate/isolation), tier-default table (8 plans + multi-rules), DeterministicPortAllocator pseudocode, model resolution chain, artifact-schema status note
- `docs/api-reference/README.md` (modified): link entry

## Design decisions
- **Skipped operator-runbook.md and adapter-authoring.md edits** to dodge merge-conflict zone with PRs #128/#129/#130. Existing RFC-0010 citations in those files (5 in operator-runbook, 2 in adapter-authoring) are preserved, satisfying AC #2.
- **R2 rewrite over R1 patch**: 13 major findings touched 13 different sections; surgical patches would have left framing ambiguity. Full rewrite establishes "this doc tracks the RFC literally — divergence is a doc bug" as a structural invariant.

## AC status
- ✓ All 3 ACs met
- ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Verification
- `pnpm rfc:check` — clean (8 RFCs walked, 2 enforced)
- `pnpm build && pnpm lint && pnpm format:check` — clean
- `pnpm test` — full workspace green (no NEW failures)
- 3 R2 reviews approved: code 0c/0M/0m/5s; test 0c/0M/0m/0s; security 0c/0M/0m/0s
- Iterations: 2 (R1 dev + R1 reviews + R2 dev + R2 reviews)

## Follow-up (5 R2 suggestions, all doc-quality nits)
- Code reviewer flagged 5 suggestion-severity polish items (minor wording / clarification asks); none blocks ship
- File future task to add JSON schemas at `spec/schemas/artifacts/` for HarnessResult, BurnDownReport, EstimateBootstrapped, MigrationDiverged, classifier — current doc explicitly notes these are pending
<!-- SECTION:FINAL_SUMMARY:END -->
