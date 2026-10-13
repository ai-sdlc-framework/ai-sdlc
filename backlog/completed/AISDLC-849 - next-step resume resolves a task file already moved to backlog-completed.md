---
id: AISDLC-849
title: >-
  next-step resume resolves a task file already moved to backlog/completed/ (and push-only accepts a missing verdict file by re-running the verdict step)
status: Done
assignee: []
created_date: '2026-10-13'
labels:
  - pipeline
  - executor
  - fix
dependencies: []
references:
  - pipeline-cli/src/next-step/init.ts
  - pipeline-cli/src/steps/01-validate.ts
  - pipeline-cli/src/next-step/next-step.ts
  - pipeline-cli/src/dispatch/resume.ts
  - pipeline-cli/src/steps/01-validate.test.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

An interrupted resume of a task whose branch already carries its Done move is refused with `no task file for <id>`. The dev subagent moves the task file from `backlog/tasks/` to `backlog/completed/` before push (the done semantics in CLAUDE.md), so every interrupted resume after the move hits it. Seen on AISDLC-828 (PR #1459) and AISDLC-837 (PR #1466). Push-only resume additionally falls back to a normal resume whenever `.ai-sdlc/verdicts/<id>.json` is absent, which re-runs the whole developer and reviewer loop. Current workaround: `git mv` the file back into `backlog/tasks/` in the worktree before resuming.

Code path found:

1. `pipeline-cli/src/steps/01-validate.ts` `validateTask` returns `no task file for <id>` (around line 198). AISDLC-822 added `resume: true` / `includeCompleted` so Step 1 accepts `backlog/completed/`, but only callers that pass `resume` benefit.
2. `pipeline-cli/src/next-step/init.ts` line 93 calls `validateTask({ taskId, workDir })` without `resume`, before it decides at line 121 whether the run is a resume. So the next-step entry point still refuses a moved file. The same applies to the other `findTaskFile(...)` calls without `includeCompleted` in `pipeline-cli/src/next-step/next-step.ts` (`rollbackStatus`) and `init.ts` (`rollbackBegun`), which silently skip.
3. `pipeline-cli/src/dispatch/resume.ts` `evaluatePushOnly` returns `normal` with `no verdict file in the worktree` when the verdict file is missing; the resume then re-runs developer and reviewers although the content is already approved on the branch.

**Five-step review (requirements first).** 1. Requirement questioned: "the task file must be in `backlog/tasks/` to resume" is not a real requirement once the dev has legitimately moved it; the move is the done semantics, not an error. 2. Deleted: the refusal, by resolving the task file from `backlog/tasks/` or `backlog/completed/` in every next-step entry (no manual `git mv`, no resume-only flag threading). 3. Simplified: determine the resume state before validation (or always pass `includeCompleted`), and let push-only with no verdict file run the verdict step (aggregate the existing reviewer outputs or re-run only the reviewers) instead of falling all the way back to a developer run. 4. Accelerated: no operator or planner `git mv` workaround per resume; no wasted developer round. 5. Automated: covered by hermetic unit tests, nothing new to run by hand.

## Fix

1. In `next-step/init.ts`, make `validateTask` accept `backlog/completed/` (reorder so the resume check runs first, or pass `resume: true` whenever the branch already has work). Use `includeCompleted` for the other `findTaskFile` calls on the resume path.
2. In push-only mode, when the verdict file is absent, compute the verdict (run the verdict step) rather than refusing or running the developer; `evaluatePushOnly` keeps failing closed when the content no longer matches an approval.
3. Unit tests for both; behaviour for a task still in `backlog/tasks/` is unchanged.

Velocity impact: positive. Removes a manual workaround from every interrupted resume; no gate added, no control loosened.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `next-step` init on a resume whose task file is only in `backlog/completed/` finds it and proceeds (no `no task file for` refusal)
- [x] #2 Push-only resume without `.ai-sdlc/verdicts/<id>.json` computes the verdict rather than refusing or re-running the developer
- [x] #3 Unit tests cover both cases; a task file in `backlog/tasks/` behaves exactly as before
- [x] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Follow-up

(none)
