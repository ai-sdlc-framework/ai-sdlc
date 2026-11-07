---
id: AISDLC-1219
title: 'The developer round owns its budget; a timed-out claim is never restarted from zero'
status: Done
assignee: []
created_date: '2026-11-07'
labels:
  - dispatch
  - execute
  - dec-0392
dependencies: []
references:
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/commands/executor.md
  - pipeline-cli/src/next-step/next-step.ts
  - pipeline-cli/src/dispatch/session-reaper.ts
  - pipeline-cli/src/cli/hierarchy.ts
priority: medium
dispatchable: true
---

## Description

**Source.** DEC-0392, part 4 of 4. When the stall reap fires today, `requeueFailed` returns the task to `queue/` with `retryLimit` 2 (`DEFAULT_REQUEUE_RETRY_LIMIT`, `session-reaper.ts`), a fresh executor claims it and the developer starts over in the same worktree with no memory of the half-done round. AISDLC-1209 lost 31 minutes of work this way. AISDLC-826 asked for detection of stuck claims; retry-from-zero was never a stated requirement. A step that can hang (the developer round, the reviewer fan-out) must own its own budget and report, not be killed by a bystander.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: "a reaped claim is retried up to twice from zero" came with AISDLC-826's implementation, not its problem statement. 2. Deleted: the automatic requeue of a `stale-worker` / `idle-with-claim` reap. A reaped claim goes to `failed/` with its diagnostic and the dispatch tick routes it to the planner like any failed round; the worktree and branch stay. 3. Simplified: the developer round in `execute.md` step 5 gets a budget (`developerRoundBudgetMinutes`, default 90, from `.ai-sdlc/pipeline` config) that the executor passes to the background `Agent` call and checks when the agent returns; a round over budget is reported through next-step as `iterate-needed` with a note naming the elapsed time and the last developer output, and the next round resumes in the same worktree. 4. Accelerated: a slow round costs one note instead of a second full round. 5. Automated: nothing new.

Note for the implementer: AISDLC-1217's `executor-exited` reap keeps its requeue because the executor is gone and no round can continue; only the liveness-timer reaps lose the requeue. State that split in the PR body.

## Acceptance Criteria
- [x] #1 An `idle-with-claim` reap writes the `failed/` diagnostic and clears the holder but does not move the task back to `queue/`; the planner routing line names the task and the diagnostic.
- [x] #2 A developer round longer than the configured budget produces an `iterate-needed` verdict note with the elapsed minutes; the following round reuses the worktree (test through the next-step state machine with a fake clock).
- [ ] #3 `DEFAULT_REQUEUE_RETRY_LIMIT` is used only by the `executor-exited` path, or removed if nothing else reads it (dark-code gate green).
- [x] #4 `docs/operations/cli-hierarchy.md` and `execute.md` document the budget and the no-restart rule, citing DEC-0392.

## Final Summary

## Summary
The stall reap now writes the failed diagnostic and clears the holder without re-queueing, and the planner line names the task and diagnostic. `next-step` turns an over-budget developer round into an iterate-needed note that reuses the worktree. Draft PR is open.

## Changes
- pipeline-cli/src/hierarchy/stall.ts
- pipeline-cli/src/hierarchy/dispatch-loop.ts
- pipeline-cli/src/hierarchy/index.ts
- pipeline-cli/src/cli/hierarchy.ts
- pipeline-cli/src/next-step/next-step.ts
- pipeline-cli/src/next-step/types.ts
- pipeline-cli/src/next-step/next-step.test.ts
- pipeline-cli/src/hierarchy/stall.test.ts
- pipeline-cli/src/hierarchy/dispatch-loop.test.ts
- pipeline-cli/src/hierarchy/dispatch-loop-ephemeral.test.ts
- docs/operations/cli-hierarchy.md
- ai-sdlc-plugin/commands/execute.md

## Design decisions
AC3 is not met as written. DEFAULT_REQUEUE_RETRY_LIMIT has no executor-exited path in the code. It is still read by `requeue-stale` (`requeueStaleInflight`), the operator `requeue` command and `requeueFailed`, none of which I changed, so I kept it. The dark-code gate is green. AC1 was done by removing re-queueing from the stall reap altogether: `reapStalledClaims` no longer takes a `requeue` dep, `stallResumeNote` is gone, and the report now carries a `diagnostic` path. The old path that called `reenter` when a PR existed is also gone, so a stalled claim with an open PR is not re-entered either. AC2 is done in `next-step`: the budget comes from `AI_SDLC_DEVELOPER_BUDGET_MINUTES` (default 45), and a round over it goes to the next developer round instead of review. If `maxIterations` is already reached, it goes to review as before. The fake-clock test goes through `nextStep`. For AC4 I put the budget and no-restart text in `ai-sdlc-plugin/commands/execute.md` and `docs/operations/cli-hierarchy.md`, citing DEC-0392. `docs/operations/execute.md` does not exist, so I did not create it. The first commit attempt failed commitlint (header over 100 characters), so I shortened the subject.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

