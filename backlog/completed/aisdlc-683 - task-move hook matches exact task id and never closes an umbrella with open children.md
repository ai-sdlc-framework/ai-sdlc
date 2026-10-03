---
id: AISDLC-683
title: >-
  check-task-moved.sh: match the exact task id and refuse to auto-close an umbrella task that still has open children
status: Done
assignee: []
created_date: '2026-10-03'
labels:
  - bug
  - hooks
  - backlog
  - security
dependencies: []
references:
  - scripts/check-task-moved.sh
  - pipeline-cli/bin/cli-task-complete.mjs
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On the first push of #1161 (AISDLC-656.1), `scripts/check-task-moved.sh` found
`(AISDLC-656)` in the sub-task's commit subjects and auto-closed the UMBRELLA task
AISDLC-656 (moved it to `backlog/completed/` in a local `chore: auto-close` commit)
while AISDLC-656.2 and AISDLC-656.3 were still open. The executor caught it before
pushing, dropped the commit and pushed with `AI_SDLC_SKIP_TASK_MOVE=1`, disclosed in
the PR body. The same thing will happen on every later push of that branch and on
any other sub-task whose commit subjects name the umbrella id. Filed by the planner
session 2026-10-03 (Decision Catalog DEC-0017).

Two defects, both in the hook:

1. **Prefix confusion is not the bug, citation is.** The regex already distinguishes
   `AISDLC-656` from `AISDLC-656.1`. The failure is that a sub-task commit may
   legitimately cite its umbrella, and the hook treats any citation as "this task is
   done". The hook must only move the task whose id matches the branch's own task
   (the `.active-task` sentinel or the `(AISDLC-N[.M])` id of the PR's task), not every
   id it finds in the range.
2. **No umbrella guard.** Even when the cited id is the task being completed, a task
   whose children (`AISDLC-N.*`) are still in `backlog/tasks/` must not move. Umbrellas
   move only when the last child completes.

## Conventions
- Bash (hook) + TypeScript strict for anything touched in `pipeline-cli` (ESM, Vitest,
  80% line coverage on new code).
- The hook runs BEFORE the attestation-sign gate; keep that order (AISDLC-220).
- This is a pre-push gate: security reviewer on the strongest model.

## Scope
1. **Exact-id selection:** resolve the task being completed from the `.active-task`
   sentinel when present, else from the single `(AISDLC-N[.M])` id that appears in
   every commit subject of the range; ignore other ids. If the range cites more than
   one candidate and no sentinel exists, do nothing and print which ids were seen.
2. **Open-children guard:** before moving `AISDLC-N`, list `backlog/tasks/aisdlc-N.*`;
   if any exist, skip the move and print the open children. When the LAST child of an
   umbrella completes, move the child; moving the umbrella itself stays a separate,
   explicit step (`cli-task-complete AISDLC-N`), not an implicit one.
3. **Regression test:** a shell or Vitest fixture with `aisdlc-656`, `aisdlc-656.1`,
   `aisdlc-656.2` task files and a commit range whose subjects contain
   `(AISDLC-656)` and `(AISDLC-656.1)`; assert that only 656.1 moves and 656 stays.
   A second case: umbrella cited alone, children open, nothing moves.
4. **Routine cleanup:** once this lands, `AI_SDLC_SKIP_TASK_MOVE=1` must no longer be
   needed on the 656.x pushes; remove the standing instruction to use it from the
   dispatch brief and note the removal in the PR body.

## Acceptance Criteria
- [ ] With the 656 / 656.1 / 656.2 fixture and a range citing both `(AISDLC-656)` and `(AISDLC-656.1)`, only `aisdlc-656.1` moves to `backlog/completed/`.
- [ ] A range citing only `(AISDLC-656)` while `aisdlc-656.2` is open moves nothing and prints the open children.
- [ ] A task with no children and a matching citation still auto-closes exactly as before (no regression on the single-task path).
- [ ] The hook still runs before `check-attestation-sign.sh` in the pre-push chain.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
