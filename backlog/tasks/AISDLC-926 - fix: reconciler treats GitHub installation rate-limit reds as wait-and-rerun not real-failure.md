---
id: AISDLC-926
title: 'fix: reconciler treats GitHub installation rate-limit reds as wait-and-rerun, not real-failure or no-match'
status: To Do
assignee: []
created_date: '2026-10-15'
labels: [bug, hierarchy, reconcile, pipeline-cli, velocity, token-cost]
dependencies: []
references: [pipeline-cli/src/hierarchy/pr-state.ts, pipeline-cli/src/hierarchy/pr-state.test.ts, pipeline-cli/src/hierarchy/reconcile.ts, pipeline-cli/src/hierarchy/reconcile.test.ts]
priority: high
dispatchable: true
---

## Description

When the GitHub App's installation rate limit is exhausted, the `Detect Changes`, `ai-sdlc/issue-link` and `ai-sdlc/pr-ready` checks fail on every open PR with the job log line `API rate limit exceeded for installation`. Nothing is wrong with the PR; the checks pass on a plain rerun after the hourly reset.

`classifyPr` in `pr-state.ts` sees a failed `ai-sdlc/pr-ready` and returns `real-failure`, whose action is a full fix resume with the failing line. On 2026-10-15 this re-entered AISDLC-877 (#1599) and AISDLC-878 (#1622) into executors for nothing, and routed #1595, #1622 and #1623 to the planner as `no-match` four times in one hour. Each false round costs an executor slot, a model run and a planner turn.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: does a red check always mean the PR is broken? No: a red whose cause is the API quota says nothing about the PR. 2. Deleted: the executor re-entry and the planner route for that shape. 3. Simplified: one new state, `rate-limited`, detected from the failing checks' output, with one action, rerun failed jobs after the reset. 4. Accelerated: no executor or planner turn is spent; the rerun is one API call. 5. Automated: detection and the rerun live in the reconciler with tests.

Detection: the failing check runs are the rate-limit shape when every failed check is one of `Detect Changes`, `ai-sdlc/issue-link`, `ai-sdlc/pr-ready` and the failed job's log (or the check output summary) contains `rate limit exceeded for installation`. Reading the log is the fallback; prefer the check-run output when the workflow writes the reason there.

Action: `wait-and-rerun`. The reconciler records the GitHub reset time from the `x-ratelimit-reset` header or the `rate_limit` endpoint, does nothing until it passes, then reruns the failed jobs once per head sha. It never re-enters the task, never routes to the planner, and the tick summary line counts PRs in this state.

## Acceptance Criteria

- [ ] `classifyPr` returns a new state `rate-limited` when every failed check is in the known set and the failure reason contains `rate limit exceeded for installation`; a failed check outside that set, or without that reason, still classifies as before.
- [ ] The action for `rate-limited` is `wait-and-rerun`: no `reenter`, no `route-to-planner`, no manifest write.
- [ ] After the recorded reset time, the reconciler reruns the failed jobs of that PR once per head sha and records the rerun on the board so a later tick does not repeat it.
- [ ] The tick summary line shows the count of rate-limited PRs and the reset time.
- [ ] Tests in `pr-state.test.ts` and `reconcile.test.ts` cover detection, the negative cases, the one-rerun-per-head rule and the summary line.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Observed 2026-10-15 17:50Z to 19:10Z across #1595, #1599, #1610, #1611, #1613, #1616, #1622, #1623. The planner ruled the shape by hand each tick; this task removes that ruling from the loop.
