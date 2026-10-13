---
id: AISDLC-860
title: >-
  Step 0.5 task sync refuses a file whose id already exists on main and runs the cli-file checks before opening the PR
status: To Do
assignee: []
created_date: '2026-10-13'
labels:
  - pipeline
  - backlog
dependencies: []
references:
  - pipeline-cli/src/execute-pipeline.ts
  - pipeline-cli/src/cli/file.ts
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Step 0.5 of the execute pipeline sweeps every untracked `backlog/tasks/*.md` in the parent into a `chore/sync-tasks-<sha>` PR, which auto-enable then arms. It performs none of the checks `cli-file task` performs (ASCII filename, backlog-drift, DoR, and above all "this id does not already exist"). On 2026-10-13 four such PRs landed (#1485, #1487, #1488, #1490); #1490 put six files on `main` whose ids `aisdlc-847..852` collide with existing tasks AISDLC-847..852, one of them differing only in case from `AISDLC-852`, which keeps every checkout on a case-insensitive filesystem permanently dirty and aborts dispatch ticks. A cleanup PR removes them; this task closes the hole.

**Five-step review (requirements first).** Requirement questioned: "Step 0.5 must land every untracked task file so the parent is clean". The clean parent is the real requirement; landing unchecked files is not. Deletion: Step 0.5 stops opening its own ad-hoc sync PR. Simplified: Step 0.5 calls the same code path as `cli-file task` for each untracked file (`pipeline-cli/src/cli/file.ts`), so there is one filing path; a file whose id already exists on `origin/main` (case-insensitive match on `backlog/tasks` and `backlog/completed`) is refused with a verdict `blocked` naming the file and the colliding task, never synced. Accelerated: no duplicate ids and no case-collision dirt ever reach main, so no cleanup PRs, no dirty-parent tick aborts. Automated: tests for a colliding id, a case-only collision and a clean new file.

## Fix

1. `pipeline-cli/src/execute-pipeline.ts` (Step 0.5): replace the ad-hoc branch+PR code with a call into the `cli-file task` implementation for each untracked file; collect refusals.
2. `pipeline-cli/src/cli/file.ts`: export the filing function with an injectable runner; add the case-insensitive duplicate-id check against `origin/main` if not already present.
3. On any refusal, Step 0.5 returns `blocked` with the file list and does not continue the task; the executor's verdict carries the reason so dispatch can route it.
4. Tests as named above.

## Acceptance Criteria

- [ ] #1 An untracked task file whose `id:` exists on `origin/main` (any case, tasks or completed) is refused and named in a `blocked` verdict; no branch or PR is created (test).
- [ ] #2 An untracked file whose filename differs only in case from a tracked file is refused the same way (test).
- [ ] #3 A clean new file is filed through the `cli-file task` path and the resulting PR passes DoR and backlog-drift (test with injected runner).
- [ ] #4 Step 0.5 has no remaining code that creates a `chore/sync-tasks-*` branch directly.

**Velocity impact.** Positive: removes a class of main pollution that cost one cleanup PR, one renumbering PR and a stalled drain in a single day.

Authority: class (a) under `docs/operations/decision-authority.md` (tightening; reversible).
<!-- SECTION:DESCRIPTION:END -->
