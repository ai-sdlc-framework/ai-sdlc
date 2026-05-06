---
id: AISDLC-199
title: >-
  ai-sdlc-pipeline execute mutates parent checkout task status instead of
  worktree-local lifecycle state
status: Done
assignee: []
created_date: '2026-05-05 18:02'
labels:
  - bug
  - pipeline-cli
  - worktree-isolation
  - framework-bug
dependencies: []
references:
  - pipeline-cli/src/execute-pipeline.ts
  - pipeline-cli/src/steps/04-flip-status.ts
  - pipeline-cli/src/steps/10-finalize.ts
  - >-
    backlog/completed/aisdlc-182 -
    CLI-add-ai-sdlc-pipeline-execute-umbrella-subcommand-for-end-to-end-Step-0-13-dispatch.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`executePipeline()` calls Step 4 `beginTask()` with `workDir: opts.workDir`, so the status flip patches `backlog/tasks` in the operator checkout rather than the per-task worktree created by Step 3. Later Step 10 finalization prefers the worktree-local task file, so the PR branch can be correct while the parent checkout is left with an uncommitted `status: In Progress` edit.

## Impact

Assistant-driven issue processing via `ai-sdlc-pipeline execute` can dirty the operator's main checkout and create confusing backlog state outside the task branch. This also weakens the worktree-isolation contract described in `CLAUDE.md` and RFC-0012.

## Suspected root cause

`pipeline-cli/src/execute-pipeline.ts` calls `beginTask({ workDir: opts.workDir, worktreePath: branch.worktreePath })`. `beginTask()` locates the task file via `findTaskFile(taskId, workDir)`, so it patches the parent repo. Step 10 uses `findTaskFile(taskId, opts.worktreePath) ?? findTaskFile(taskId, opts.workDir)`, which means finalization and Step 4 are operating on different copies in real worktree runs.

## Implementation notes

Prefer running lifecycle mutations against the worktree checkout after Step 3, or explicitly model parent-checkout status as transient state and revert/mirror it deterministically. Add a regression test with a real copied task file in both parent and worktree locations so the bug is visible without a fake worktree masking it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `executePipeline()` Step 4 status mutation targets the per-task worktree checkout or otherwise leaves the parent checkout clean after a successful run.
- [ ] #2 Regression test proves the parent repo task file is not left with an uncommitted `status: In Progress` edit after a successful umbrella execution.
- [ ] #3 Regression test proves Step 10 finalization still moves the worktree-local task file to `backlog/completed/` and commits the lifecycle change on the task branch.
- [ ] #4 Documentation or inline comments clarify which checkout owns lifecycle edits during `ai-sdlc-pipeline execute`.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped via PR #336 (fix(orchestrator): step 4 beginTask targets worktree, not parent checkout). This lifecycle close was missed by the original PR (per AISDLC-203 — Codex/automation workflow doesn't atomically complete tasks); batched into chore/backlog-sync 2026-05-05.
<!-- SECTION:FINAL_SUMMARY:END -->
