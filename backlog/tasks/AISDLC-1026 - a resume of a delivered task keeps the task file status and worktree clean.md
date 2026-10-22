---
id: AISDLC-1026
title: >-
  A resume of a delivered task never rewrites the completed task file, so the worktree stays clean for Step 10.5
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - orchestrator
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/steps/04-flip-status.ts
  - pipeline-cli/src/steps/01-validate.ts
  - pipeline-cli/src/orchestrator/rollback.ts
  - docs/operations/backlog-and-execution-reference.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (dispatch finding, 2026-10-22).** An executor resumed a delivered task whose PR already existed and whose task file already sat in `backlog/completed/` with `status: Done`. Step 4 flipped that file to `In Progress`, and the failure rollback then rewrote it to the pre-dispatch default `To Do`. The rewritten task file dirtied the worktree, and the Step 10.5 pre-sign rebase refused to run on a dirty tree. The resume therefore failed for a reason unrelated to the code under review, and dispatch had to route it to the planner.

**Root cause.** The status flip in Step 4 and the revert in the rollback treat every run as a fresh start. Step 1 already recognises a resumed completed task (`resumedCompleted`), but Step 4 and the rollback do not consult that flag, so a `Done` file is flipped and then "restored" to `To Do`.

**Five-step review (requirements first).**
1. Requirement questioned: "every run flips the task status to `In Progress` and the rollback restores the pre-dispatch value". For a resume of a delivered task the status is already final; nothing needs flipping.
2. Delete: the flip and the revert on a resumed completed task (both become no-ops when Step 1 reports `resumedCompleted`).
3. Simplify: the rollback restores the status it actually read, never a synthesized `To Do`; when the read fails it leaves the file alone and logs it.
4. Accelerate: Step 10.5 names the dirtying path in its dirty-tree refusal so the next such case is diagnosed from the log line.
5. Automate: a unit test for Step 4 and one for the rollback with a `backlog/completed/` task file, asserting the file bytes are unchanged.

**Velocity impact.** Positive: resumes of delivered PRs no longer fail on a self-inflicted dirty tree.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Step 4 leaves a task file under `backlog/completed/` byte-identical when Step 1 reports a resumed completed task (unit test)
- [ ] #2 The rollback never writes `To Do` to a file whose pre-dispatch status was `Done`, and never writes a synthesized status when the pre-dispatch read failed (unit test)
- [ ] #3 The Step 10.5 dirty-tree refusal lists the dirty paths
- [ ] #4 `docs/operations/backlog-and-execution-reference.md` states that a resume of a delivered task does not touch the task file
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check`
