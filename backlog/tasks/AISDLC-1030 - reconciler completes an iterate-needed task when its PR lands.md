---
id: AISDLC-1030
title: >-
  The landing transition completes a task whose last verdict is iterate-needed when its PR merges
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - dispatch
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/hierarchy/land-eligible.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/dispatch/complete.ts
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (2026-10-22).** AISDLC-1013 (PR #1847) and AISDLC-1027 (PR #1885) each ended with an `iterate-needed` verdict that, by design, keeps the executor's slot while the iteration runs. Both PRs then merged by auto-merge after a lease push, with no later verdict written. The task stayed inflight, the executor could not be cleared ("still inflight"), and dispatch had to hand-run `cli-dispatch complete --outcome success` on a planner ruling each time. A merged PR is the strongest possible verdict: nothing is left to iterate.

**Root cause.** The landing report stamps `landed` on a `done/` verdict only; a task whose verdict is `iterate-needed` is not in `done/`, so the merge of its PR changes nothing on the board.

**Five-step review (requirements first).**
1. Requirement questioned: "only an executor writes the final verdict". Replaced by: a merged PR completes its task; the executor's slot is released by the landing.
2. Delete: the hand-run `complete` ruling (two today) and the planner round trip behind it.
3. Simplify: when `landEligible` (or the reconciler's landed detection) sees a PR merged whose task is inflight with an `iterate-needed` verdict, it calls the existing `complete` path with `outcome: success`, `pr` and the inflight worker, and stamps `landed`; nothing new is invented.
4. Accelerate: the executor's clear is no longer refused for that task, so the slot frees on the same tick.
5. Automate: unit test with an inflight iterate-needed task whose PR is merged → `done/` verdict success with `landed`, inflight entry removed; a merged PR of a task already in `done/` is unchanged.

**Velocity impact.** Positive: one freed executor slot per occurrence without a planner ruling.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 A merged PR whose task is inflight with an `iterate-needed` verdict is completed as `success` (worker, pr, `landed` stamp) by the landing or reconcile transition (unit test)
- [ ] #2 A merged PR whose task already holds a `done/` verdict only receives the `landed` stamp, as today (unit test)
- [ ] #3 The tick output names the auto-completed task
- [ ] #4 `docs/operations/cli-hierarchy.md` states that a landed PR completes an iterate-needed task
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.
