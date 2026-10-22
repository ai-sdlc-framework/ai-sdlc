---
id: AISDLC-1025
title: >-
  A task carrying a `--until` rule is never claimable, and an executor start without sender pid and ref is refused
status: Done
assignee: []
created_date: '2026-10-22'
labels:
  - dispatch
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/dispatch/claim-wait.ts
  - pipeline-cli/bin/cli-dispatch.mjs
  - ai-sdlc-plugin/commands/executor.md
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (RCA of the 2026-10-21 Step 10.5 outage, dispatch side).** While the hotfix was queued first, dispatch put `rule --until AISDLC-1017` on every other queued task so only the hotfix could be claimed. An executor still claimed one of the ruled tasks, ran its developer stage and all three reviews, and failed at the same Step 10.5 wall, burning a full run. Dispatch also reported that the executor started with an unchecked start (no sender pid or ref), so the roster could not tell who issued the command.

**Root cause.** The rule is enforced by `next-step` after the claim, not by the claim itself; and the executor command accepts a start whose sender it cannot verify.

**Five-step review (requirements first).**
1. Requirement questioned: "rules are advisory text the executor reads". Replaced by: a `--until` rule is a claim predicate.
2. Delete: the executor-side refusal path for ruled tasks (it never runs if the claim refuses first).
3. Simplify: `claim` skips any manifest whose rule names a task without a `done/` verdict, logging the skip once per tick; the rule self-releases exactly as today.
4. Accelerate: the executor command refuses to start when the sender pid or ref is missing and reports `unchecked-start` to dispatch instead of claiming.
5. Automate: unit tests for the claim predicate and the start refusal.

**Velocity impact.** Positive: no wasted full runs on tasks that are known to fail.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `claim` never returns a manifest whose `--until` rule names a task without a `done/` verdict (unit test with one ruled and one free manifest)
- [x] #2 The executor command refuses an unchecked start and reports it to dispatch in one line (hook or unit test)
- [x] #3 `docs/operations/cli-hierarchy.md` states that a rule gates the claim
- [x] #4 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check`

## Final Summary

## Summary
A manifest whose ruling `--until` task has no success verdict in `done/` is now skipped by `claim` and shown as ineligible with a reason. `executor-start` refuses with `unchecked-start` and claims nothing when neither `--sender-pid` nor `--sender-ref` is given. A draft PR is open.

## Changes
- pipeline-cli/src/dispatch/board.ts
- pipeline-cli/src/dispatch/board-ordering.test.ts
- pipeline-cli/src/hierarchy/executor-start.ts
- pipeline-cli/src/hierarchy/executor-start.test.ts
- pipeline-cli/src/cli/hierarchy.ts
- ai-sdlc-plugin/commands/executor.md
- docs/operations/cli-hierarchy.md
- backlog/tasks/AISDLC-1025 - a ruled task is not claimable and an executor start is always checked.md

## Design decisions
The rule is enforced in `checkEligibility`, so `claim` and the board listing share it. The refusal is a thrown error starting with `unchecked-start`. The executor sends the one-line report to dispatch, as `executor.md` now instructs. I removed the task id from `executor.md` because a gate rejects internal task ids in adopter-visible text. The task file diff is only the status change to In Progress. The PR is a draft, so `/ai-sdlc execute` still has to run the reviewers and mark it ready. I did not run coverage locally.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

