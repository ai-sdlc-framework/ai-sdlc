---
id: AISDLC-1381
title: "A task's filing PR never retires it as landed"
status: To Do
assignee: []
created_date: '2026-11-22'
labels:
  - bug
  - dispatch
  - pipeline-cli
dependencies: []
references:
  - pipeline-cli/src/dispatch/retire-landed.ts
  - pipeline-cli/src/dispatch/board.ts
priority: high
---

## Description

**Gap.** AISDLC-1308 was never implemented, yet the board retired it as landed, so its dependant AISDLC-1309 has been held since 2026-11-18 with "task AISDLC-1308 is not on the board".

**Observed.**

- `.ai-sdlc/dispatch/board-events.jsonl`: `{"event":"retire-failed-landed","taskId":"AISDLC-1308","reason":"task landed 5700aa6b6c3c78174f8a3446724c98ed84701e56","at":"2026-11-18T14:50:30.973Z"}`.
- `5700aa6b6` is `chore(docs): file backlog task AISDLC-1308 (AISDLC-1308) (#2764)`, the filing PR. The task file is still `backlog/tasks/aisdlc-1308 - python sdk validates all eleven resource kinds of the reference.md` on main.
- AISDLC-1297 (`4799de7aa`, landed 2026-11-17T20:30Z) added "retire only for own code PR" (`retire-landed.ts:44`), yet this retire happened the next day, so a path still lets a filing PR through (for example a landing record without a kind, or the sweep at `retire-landed.ts:157-173` that takes `r.landedSha ?? r.headSha`).

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: a task is landed only when its code PR merges and its file is in `backlog/completed/`. 2. Deleted: any retire path that accepts a landing record not proven to be the task's code PR. 3. Simplified: one predicate used by every retire path. 4. Accelerated: none. 5. Automated: regression test with the AISDLC-1308 shape.

- Find the path that retired AISDLC-1308 and route it through the AISDLC-1297 predicate; a record with an unknown kind or a `chore(docs): file backlog task` subject is not a landing.
- Before any retire to `done/`, require the task file to be under `backlog/completed/` on main (`isDoneOnMain`, `board.ts:318`); otherwise leave the verdict where it is.
- Scan `retired/` and `done/` for tasks whose file is still in `backlog/tasks/` and list them in the PR body; put AISDLC-1308 back on the queue (`cli-dispatch enqueue` or the documented path).

## Acceptance Criteria

- [ ] #1 A regression test: a landing record for a filing PR (`chore(docs): file backlog task X (X)`) does not retire task X, from both the per-PR path and the sweep.
- [ ] #2 A test: a retire whose task file is not in `backlog/completed/` on main is refused.
- [ ] #3 AISDLC-1308 is back on the queue and AISDLC-1309's hold reason reads "waiting for AISDLC-1308 to finish".
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
