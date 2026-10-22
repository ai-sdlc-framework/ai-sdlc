---
id: AISDLC-1027
title: >-
  The queue derives `after` from the task file's dependencies and holds a claim until every dependency has landed
status: To Do
assignee: []
agent: []
created_date: '2026-10-22'
labels:
  - dispatch
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/dispatch/enqueue.ts
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/next-step/init.ts
  - pipeline-cli/src/deps/dependency-graph.ts
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (dispatch finding, 2026-10-22).** A task whose frontmatter named two dependencies was requeued by hand after a failure. Its manifest carried no `after` list, so the board offered it as eligible, an executor claimed it, and the executor's dependency preflight (`next-step` init, `dependency-graph`) refused it because neither dependency was Done. The claim, the clear and the preflight were wasted, the task landed in `failed/` and dispatch had to route it to the planner. The same shape hit two other tasks the same afternoon.

**Root cause.** Two gates disagree. The board holds a manifest back only on its own `after` list, which `enqueue` fills from the brief and nobody fills on a hand requeue; and the board treats a dependency as met when a `done/` verdict exists (delivered), while the executor preflight requires the dependency's task file to be Done on `main` (landed). A manifest with no `after`, or one whose dependency is delivered but not landed, passes the board and fails the executor.

**Five-step review (requirements first).**
1. Requirement questioned: "the brief author lists `after` by hand and the executor checks the real dependencies". The task file already declares `dependencies:`; the board should read them.
2. Delete: nothing to delete; the executor preflight stays as the last line of defence.
3. Simplify: `enqueue` (and the requeue and reprioritize paths that write a manifest) fills `after` from the task file's `dependencies:` when the caller passes none, so every manifest carries its dependencies.
4. Accelerate: the board's unmet-`after` predicate uses the same "landed" test as the executor preflight (task file Done on `main`, or a `done/` verdict marked landed), so a claim is never offered that the preflight will refuse.
5. Automate: unit tests for the derived `after`, for the landed-not-delivered hold, and one board-invariants case asserting an eligible manifest always passes the preflight predicate.

**Velocity impact.** Positive: no wasted claims and clears on tasks that cannot start; dispatch stops hand-checking dependencies before every requeue.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 A manifest written by `enqueue`, `requeue` or `reprioritize` without an explicit `after` carries the task file's `dependencies:` as `after` (unit test)
- [ ] #2 The board holds a manifest whose dependency is delivered but not landed, and releases it once the dependency has landed (unit test)
- [ ] #3 A board-invariants test asserts that every eligible manifest passes the executor's dependency preflight predicate
- [ ] #4 `docs/operations/cli-hierarchy.md` states that `after` is derived from `dependencies:` and that a dependency counts as met only once landed
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check`
