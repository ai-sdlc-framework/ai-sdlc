---
id: AISDLC-1244
title: 'A queued task held on a dependency that is dispatchable: false is routed to the planner once with the reason, instead of sitting held indefinitely'
status: To Do
assignee: []
created_date: '2026-11-08'
labels:
  - dispatch
  - board
  - automation
dependencies: []
references:
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/dispatch/ranking.ts
  - pipeline-cli/src/hierarchy/planner-notify.ts
  - pipeline-cli/src/dor/dispatch-readiness.ts
priority: medium
dispatchable: true
dispatchableReason: 'Operator ruling 2026-11-08: every gap the planner wake catches by hand becomes an automation task. Gap: AISDLC-506 sat held on AISDLC-496 for 2 days and 9 wakes; 496 is dispatchable: false (operator-in-loop) and its remaining ACs are carried by 506 itself, so the hold could never clear. The planner found this by reading both task files by hand; the board only said "held".'
---

## Description

**Gap.** The board holds a queued task while a dependency is not landed. When that dependency is `dispatchable: false` with an operator reason, or is not on the board at all, the hold has no automatic exit: no executor will ever claim the dependency. `cli-hierarchy status` prints `held: AISDLC-506 (task AISDLC-496 is not on the board)` on every tick and nothing routes the condition anywhere. Two such holds today were circular (AISDLC-1179.1 on 1179, AISDLC-506 on 496): the dependency closes only when the dependent lands.

**Shape.** When the tick evaluates a held task, it classifies the hold: `waiting` (dependency queued or inflight), `operator-gated` (dependency `dispatchable: false` on `origin/main`), `absent` (dependency open but not on the board), `circular` (the dependency's task file names the held task in its body or its remaining ACs reference the held id). For `operator-gated`, `absent` and `circular` it writes one landing-style record `held/<id>.json` with the class and the two task paths, and types one line into the planner session through `planner-notify.ts` (once per (task, dependency, class); no repeats on later ticks). The planner then drops the dependency with `cli-file task --update`, parks the task, or leaves it. `cli-hierarchy status` prints the class next to the held line.

## Fix

**Five-step review (requirements first).**
1. Question: should the tick drop a circular dependency by itself? No: dropping a dependency is a planner call (class a, recorded in the task file). The tick only detects and reports.
2. Delete: nothing.
3. Simplify: one classifier function over the held set, one record, one line; reuse `planner-notify.ts`.
4. Accelerate: none.
5. Automate: tests for the four classes, the once-only notify, and the status line.

## Acceptance Criteria

- [ ] AC-1: the held classifier returns `waiting`, `operator-gated`, `absent` or `circular` for fixtures built from the 506/496 and 1179.1/1179 cases; tests.
- [ ] AC-2: a non-`waiting` hold produces one planner line and one `held/<id>.json`, and later ticks produce nothing new while the class is unchanged; test.
- [ ] AC-3: `cli-hierarchy status` shows the class on the held line; test.
- [ ] AC-4: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
