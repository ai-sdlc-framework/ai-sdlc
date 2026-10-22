---
id: AISDLC-1025
title: >-
  A task carrying a `--until` rule is never claimable, and an executor start without sender pid and ref is refused
status: To Do
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
- [ ] #1 `claim` never returns a manifest whose `--until` rule names a task without a `done/` verdict (unit test with one ruled and one free manifest)
- [ ] #2 The executor command refuses an unchecked start and reports it to dispatch in one line (hook or unit test)
- [ ] #3 `docs/operations/cli-hierarchy.md` states that a rule gates the claim
- [ ] #4 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check`
