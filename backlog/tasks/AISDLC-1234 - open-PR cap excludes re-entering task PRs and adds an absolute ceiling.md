---
id: AISDLC-1234
title: open-PR cap excludes re-entering task PRs and adds an absolute ceiling
status: In Progress
priority: high
labels: [dispatch, hierarchy, throughput, pipeline-cli]
dependencies: []
dispatchable: true
---

## Problem

DEC-0373 blocks new-task claims while open task PRs are at `openPrLimit` (default `executors.max`, 3). `openTaskPrs()` in `pipeline-cli/src/hierarchy/open-pr-limit.ts` counts every landing record with `kind: task` that is neither landed nor closed-unlanded, including a PR whose task is in an executor round (inflight claim) or has a queued repair manifest. On 2026-11-07 #2496 and #2508 held two of three slots for most of the day while 17 tasks queued. Later that day four re-entering PRs (#2508 #2520 #2528 #2529) held every slot and blocked AISDLC-1233, the new task that fixed the push failure stranding all four (DEC-0398: the operator raised the limit by hand to break the deadlock).

DEC-0396 (answered 2026-11-08, exclude-reentering with ceiling) rules:

1. A task PR whose task has a live inflight manifest or a queued manifest with `repair: true` (or `fixesPr` / `resume`) does not count toward the claim block.
2. Total open task PRs of any state may not exceed `openPrLimit + executors.max` (6 today). At that ceiling new-task claims are blocked regardless of rule 1. This is a tightening and needs no further decision.

## Fix

**Five-step review (requirements first).**
1. Question: the cap exists to bound delivered PRs waiting on merge, not PRs under active rework; but back-pressure must survive the case where every open PR is in rework (fleet-wide push failure).
2. Delete: nothing.
3. Simplify: `openPrState()` returns `{ limit, open, counted, ceiling, atLimit, atCeiling }`; `counted` = `open` minus re-entering; `atLimit` = `counted.length >= limit || open.length >= ceiling`. One derived number, no new config key.
4. Accelerate: `formatOpenPrs` prints `OPEN PRS <counted> of limit <limit> (<open> open, ceiling <ceiling>)` and names the re-entering PRs excluded; `heldReason` names which bound held.
5. Automate last: tests below.

Re-entering detection reads the board only (inflight/ and queue/ manifests by task id), never GitHub, so the tick cost does not change.

## Acceptance Criteria

- [ ] `openTaskPrs()` (or a new `countedTaskPrs()`) excludes a task PR whose task id has an inflight manifest or a queued manifest marked repair; unit tests cover: inflight claim, queued repair, queued plain (still counts), landed (never counts).
- [ ] A ceiling of `openPrLimit + executors.max` blocks new-task claims when total open task PRs reach it even if `counted` is below the limit; unit test with 4 re-entering + 2 delivered at limit 3 / max 3 holds; 4 re-entering + 1 delivered claims.
- [ ] `ephemeral-tick.ts` uses the new state; repairs remain exempt from both bounds.
- [ ] `cli-hierarchy status` prints both numbers and the excluded PRs; `docs/operations/cli-hierarchy.md` and `docs/operations/merge-without-queue.md` describe the two bounds and cite DEC-0396.
- [ ] Regression test reproducing 2026-11-07 23:5xZ: four open re-entering task PRs, limit 3, one new queued task: the task claims.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.

## References

- DEC-0373 (cap), DEC-0396 (this ruling), DEC-0398 (manual cap raise 2026-11-08)
- `pipeline-cli/src/hierarchy/open-pr-limit.ts`, `pipeline-cli/src/hierarchy/ephemeral-tick.ts`, `pipeline-cli/src/hierarchy/status.ts`
