---
id: AISDLC-1273
title: 'Held-task triage: "circular" only for a real dependency cycle, and a failed dependency gets its own label'
status: To Do
assignee: []
created_date: '2026-11-13'
labels:
  - pipeline-cli
  - hierarchy
dependencies: []
references:
  - pipeline-cli/src/hierarchy/held-triage.ts
  - pipeline-cli/src/hierarchy/held-triage.test.ts
priority: low
dispatchable: true
dispatchableReason: 'Reported by the ai-sdlc-io planner 2026-11-13 (operator standing order 2026-11-09: file every io-planner report). The monorepo planner verified that held-triage.ts classifies a hold as circular when the dependency task body merely mentions the held task id. One classifier and its tests.'
---

## Description

**Gap.** The held-task line typed into the ai-sdlc-io planner on 2026-11-13 read "Held task IO-43 waits on IO-48 (circular)". IO-43 depends on IO-39, IO-42 and IO-48; IO-48 depends on IO-42 only. There is no cycle. IO-48 was a failed task.

`pipeline-cli/src/hierarchy/held-triage.ts` returns `circular` when the text of the dependency's task body contains the held task's id (line 36). A mention is not a dependency: a task that names its dependant in prose is labelled as a cycle, and the planner is told the hold can never clear.

**Shape.** `circular` is returned only when the dependency's declared `dependencies` lead back to the held task, directly or through other tasks. A dependency that sits in the failed directory gets a new class, `failed-dependency`, and the typed line says the held task waits on a failed task.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the line exists so the planner knows why a task is held and what would release it; a wrong reason is worse than none. 2. Deleted: the body-text match. 3. Simplified or optimised: read the declared `dependencies` field that the board already parses. 4. Accelerated: n/a. 5. Automated: unit tests for a mention without a cycle, a real cycle and a failed dependency.

## Acceptance Criteria

- [ ] #1 A dependency whose body mentions the held task id, with no dependency path back to it, is not classified `circular`; a test reproduces the IO-43 and IO-48 shape.
- [ ] #2 A direct cycle and a cycle through a third task are both classified `circular`.
- [ ] #3 A dependency that is a failed task is classified `failed-dependency`, and the line typed to the planner names it as a failed task.
- [ ] #4 The other classes (`waiting`, `operator-gated`, `absent`) keep their present results; existing tests pass with only the changed expectations edited.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
