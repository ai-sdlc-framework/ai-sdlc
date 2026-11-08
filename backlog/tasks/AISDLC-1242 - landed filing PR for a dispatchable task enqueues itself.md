---
id: AISDLC-1242
title: 'A landed filing PR for a dispatchable task with a brief enqueues the task on the next tick and tells the planner, instead of waiting for a planner wake'
status: In Progress
assignee: []
created_date: '2026-11-08'
labels:
  - dispatch
  - filing
  - automation
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/planner-notify.ts
  - pipeline-cli/src/cli/file.ts
  - pipeline-cli/src/dispatch/enqueue.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
dispatchableReason: 'Operator ruling 2026-11-08: every gap the planner wake catches by hand becomes an automation task until the wake catches nothing. Gap: on 2026-11-08 seven cli-file filings (1235, 1236, 1237, 654.1, 1239, 1240, 1241) each waited for a planner turn to run brief --notify and order enqueue after the filing PR merged; cli-file --pr already writes the one-task brief, so the manual step is only the enqueue.'
---

## Description

**Gap.** `cli-file task --pr` writes a one-task dispatch brief (`--brief`, default on) and opens the filing PR. When that PR merges, nothing enqueues the task: the planner notices on its next wake, runs `cli-hierarchy brief --tasks <id> --notify`, then sends dispatch an enqueue order, and dispatch runs `cli-dispatch enqueue --from-brief`. Each filing therefore waits up to one wake interval plus two model turns. On 2026-11-08 this was the single most repeated manual step of the day.

**Shape.** The reconciler (`reconcile.ts`), which already classifies a landed `ai-sdlc/file-<id>` branch as a filing (AISDLC-1235), looks up the brief `tasks-<id>.md` written by that filing. When the brief exists, the task file on `origin/main` has `dispatchable: true`, no `blocked.reason`, and the task is not already on the board, the tick enqueues it from the brief (wave and priority from the brief) and types one line into the planner session through `planner-notify.ts`: `auto-enqueued AISDLC-N from tasks-aisdlc-n.md (filing #PR landed)`. A task filed with `dispatchable: false`, a `--update` filing, or a task already on the board is left alone and no line is sent. The planner can still reorder with `reprioritize` or hold with `cli-hierarchy hold`.

## Fix

**Five-step review (requirements first).**
1. Question: should a filing land straight onto the queue without a planner look? The planner already decided when it wrote `dispatchable: true` and the brief; the enqueue is mechanical. Yes.
2. Delete: the planner's manual `brief --notify` plus enqueue order for one-task filings disappears; `brief --tasks` stays for multi-task briefs and reorders.
3. Simplify: one predicate in the reconciler, reusing `enqueue --from-brief` and the existing planner notify path.
4. Accelerate: none.
5. Automate: unit tests for the predicate (dispatchable, blocked, already on board, update filing, no brief) and for the notify line; no network.

## Acceptance Criteria

- [ ] AC-1: a landed `ai-sdlc/file-<id>` PR whose brief exists and whose task is `dispatchable: true`, unblocked and off the board is enqueued on the next tick with the brief's wave and priority; test.
- [ ] AC-2: `dispatchable: false`, `blocked.reason`, an `--update` filing branch, or a task already on the board: no enqueue, no line; tests for each.
- [ ] AC-3: the planner session receives exactly one line per auto-enqueue through `planner-notify.ts`; test with the injected sink.
- [ ] AC-4: `docs/operations/cli-hierarchy.md` filing section states the auto-enqueue in two sentences and that `brief --notify` remains for multi-task briefs.
- [ ] AC-5: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
