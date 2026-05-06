---
id: AISDLC-200
title: >-
  ai-sdlc-pipeline execute skips cleanup and rollback when Step 4 begin-task
  throws after worktree creation
status: Done
assignee: []
created_date: '2026-05-05 18:02'
labels:
  - bug
  - pipeline-cli
  - rollback
  - worktree-isolation
  - framework-bug
dependencies: []
references:
  - pipeline-cli/src/execute-pipeline.ts
  - pipeline-cli/src/cli/execute.ts
  - pipeline-cli/src/orchestrator/rollback.ts
  - >-
    backlog/completed/aisdlc-182 -
    CLI-add-ai-sdlc-pipeline-execute-umbrella-subcommand-for-end-to-end-Step-0-13-dispatch.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`executePipeline()` creates the task worktree in Step 3, then calls Step 4 `beginTask()`, and only starts the `try/finally` cleanup wrapper after Step 4 succeeds. If Step 4 throws after Step 3 succeeds, Step 13 cleanup does not run and the CLI wrapper cannot invoke rollback because `executePipeline()` throws instead of returning a `PipelineResult`.

## Impact

A failed status patch or sentinel write can leave behind a worktree, branch, and possibly partial lifecycle edits. The AISDLC-177 rollback path currently handles returned failure outcomes, but not this early throw path.

## Suspected root cause

The cleanup guard in `pipeline-cli/src/execute-pipeline.ts` begins after `beginTask()`. `runExecuteCommand()` catches thrown errors and returns `ok:false` before reaching the `ROLLBACK_OUTCOMES` membership check.

## Implementation notes

Broaden the cleanup/rollback boundary to cover Step 3 onward. If Step 3 has created a worktree and any subsequent setup step throws, Step 13 and/or `rollbackDispatch()` should run best-effort with the computed branch and worktree path. Preserve the original error in the result envelope.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 If Step 4 throws after Step 3 succeeds, the per-task worktree sentinel/worktree cleanup runs best-effort.
- [ ] #2 The CLI wrapper invokes rollback or equivalent cleanup for early setup throws after branch/worktree resolution.
- [ ] #3 Regression test simulates Step 3 success followed by Step 4 failure and asserts no stale worktree/sentinel is left behind.
- [ ] #4 Returned CLI JSON preserves the original failure reason and includes any cleanup/rollback warnings for operator visibility.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped via PR #337 (fix(orchestrator): expand cleanup/rollback boundary to cover Step 3+ throws). This lifecycle close was missed by the original PR (per AISDLC-203 — Codex/automation workflow doesn't atomically complete tasks); batched into chore/backlog-sync 2026-05-05.
<!-- SECTION:FINAL_SUMMARY:END -->
