---
id: AISDLC-1125
title: reconcile failed-action retry loop freezes a PR at action=reenter instead of routing it
status: In Progress
assignee: []
created_date: '2026-10-30'
labels:
  - hierarchy
  - velocity
priority: high
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/reenter.ts
  - pipeline-cli/src/hierarchy/pr-rows.ts
  - docs/operations/cli-hierarchy.md
---

## Description

On 2026-10-30 the board showed seven open PRs at `action=reenter reason=real-failure` on every reconcile pass, three of them (#2093, #2127, #2129) with `lastActionAt` frozen for 21 to 34 hours while the scheduler ran every 60 seconds. Their landing records carry `actionFailed: true` and `agedAttempts: 2`. No executor ever picked them up and nothing reached the planner.

Cause, traced in `pipeline-cli/src/hierarchy/reconcile.ts`: the first `reenter` on a head writes a loop-guard entry; every later call on the same head is refused by the guard in `reenter.ts` (`reenter()` loop guard), the command exits non-zero and the executor marks `actionFailed`. From then on each pass takes the failed-action retry branch, which re-runs the same refused command, keeps `actionFailed`, never updates `lastActionAt`, and skips the aging branch because `actionFailed` is set. The same-head guard and the aging cap, which both route to the planner, are never reached. The reconcile log and `cli-hierarchy status` print the stored `action=reenter`, so the row looks live while it is a silent retry loop.

**Five-step review (requirements first).** Requirement questioned: must a failed action be retried at all on an unchanged head? No: a command refused by the loop guard on the same head will be refused again, so a retry on the same head is wasted. Deletion: delete the unconditional re-run in the failed-action branch; a failed action on an unchanged head is a terminal state for that head. Simplified: one rule, "a second failure on the same head routes to the planner once", reusing the existing `guardSameHead` and `routeOnce` paths instead of a new state. Accelerated: the stuck PR reaches the planner within one pass of the second failure instead of never. Automated last: `cli-hierarchy status` marks such rows `action=reenter (failed, routed)` so a stall is visible without reading landing records.

## Fix

1. `pipeline-cli/src/hierarchy/reconcile.ts`: in the failed-action retry branch, re-run the command only when the head, state or ruling changed since the failure; otherwise route to the planner once through the same-head path (`<action>@<sha> failed x<n>`) and stamp `lastActionAt`. The aging branch is not skipped by `actionFailed`; a failed action ages like any other.
2. `pipeline-cli/src/hierarchy/reconcile.ts`: every re-run, successful or failed, updates `lastActionAt` and keeps the command's stderr tail in the landing record (`lastActionNote`), so a frozen timestamp can no longer hide a loop.
3. `pipeline-cli/src/hierarchy/pr-rows.ts`: the status row and the reconcile log line show `failed xN` after the action when `actionFailed` is set.
4. `docs/operations/cli-hierarchy.md`: one paragraph on failed-action handling and what the planner receives.

## Velocity impact

A PR whose re-entry is refused reaches the planner within one scheduler pass instead of sitting for days; the 60-second silent retry of a command known to fail stops, saving one node process per PR per minute.

## Acceptance Criteria

- [ ] Unit test: a `reenter` command that fails twice on the same head produces exactly one route-to-planner report naming the PR, the sha and the failure count, and the record's `lastActionAt` moves on each attempt.
- [ ] Unit test: a failed action on a head that later changes is re-run once on the new head.
- [ ] Unit test: a record with `actionFailed: true` still ages and reaches the aging cap.
- [ ] Unit test: the status row for a failed action reads `reenter (failed x2)`.
- [ ] Replaying the 2026-10-30 landing records for #2093, #2127 and #2129 through `reconcile` with a stub executor routes all three to the planner on the first pass.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.
