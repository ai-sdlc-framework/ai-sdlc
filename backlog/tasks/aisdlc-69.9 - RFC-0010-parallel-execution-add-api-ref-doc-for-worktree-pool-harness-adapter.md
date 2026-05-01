---
id: AISDLC-69.9
title: RFC-0010 parallel execution — add api-ref doc for worktree pool / harness adapter
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
  - spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
  - docs/api-reference/
  - docs/operations/operator-runbook.md
  - docs/operations/adapter-authoring.md
parent_task_id: AISDLC-69
priority: low
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
