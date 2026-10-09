---
id: AISDLC-770
title: >-
  task-from-file tick works for a task file that is not on main
status: Done
assignee: []
created_date: '2026-10-09'
labels:
  - orchestrator
  - pipeline
dependencies: []
references:
  - pipeline-cli/src/steps/03-setup-worktree.ts
  - pipeline-cli/src/steps/04-flip-status.ts
  - pipeline-cli/src/orchestrator/loop.ts
  - docs/operations/operator-runbook.md
  - docs/audits/2026-10-09-clock-dependent-test-red-main-rca.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

`cli-orchestrator tick --task-from-file <path>` (AISDLC-373) is the documented single-PR path for landing a task file and its fix together, which is the only way to fix a red main that blocks every PR. On 2026-10-09 it aborted twice at Step 4 with `no task file found for AISDLC-767 under .worktrees/aisdlc-767 or <main checkout>`. Step 3 always runs `git worktree add ... origin/main`, so the fresh worktree never holds the file, and Step 4 resolves the task by id (`findTaskFile(worktree) ?? findTaskFile(workDir)`) and ignores `taskFilePathOverride`, which only Step 1 honours. The runbook procedure (`mkdir .worktrees/<id>/backlog/tasks` then tick) cannot succeed. RCA: `docs/audits/2026-10-09-clock-dependent-test-red-main-rca.md`.

## Scope

1. Thread `taskFilePathOverride` through Steps 3, 4 and 5: Step 3 copies the file into the fresh worktree at `backlog/tasks/<basename>` (or reuses an existing worktree on the computed branch), Step 4 reads that copy, Step 5 builds the dev prompt from it.
2. The dev's PR carries the task file; the pre-push task-move hook handles the move to completed as today.
3. Hermetic test: a task file under a scratch path, not on main, dispatches with a mock spawner and the worktree holds the file after Step 4.
4. Correct the runbook section "single-PR operator-driven path".

Sequencing: none.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] AC-1: `tick --task-from-file` on a file absent from main reaches Step 5 with the file present in the worktree.
- [x] AC-2: The frontier path without the flag is unchanged, covered by the existing tests.
- [x] AC-3: The runbook procedure works as written.
- [x] AC-4: New and existing tests pass.
<!-- AC:END -->
