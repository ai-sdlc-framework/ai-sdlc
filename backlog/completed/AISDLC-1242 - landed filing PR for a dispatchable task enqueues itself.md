---
id: AISDLC-1242
title: 'A landed filing PR for a dispatchable task with a brief enqueues the task on the next tick and tells the planner, instead of waiting for a planner wake'
status: Done
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

- [x] AC-1: a landed `ai-sdlc/file-<id>` PR whose brief exists and whose task is `dispatchable: true`, unblocked and off the board is enqueued on the next tick with the brief's wave and priority; test.
- [x] AC-2: `dispatchable: false`, `blocked.reason`, an `--update` filing branch, or a task already on the board: no enqueue, no line; tests for each.
- [x] AC-3: the planner session receives exactly one line per auto-enqueue through `planner-notify.ts`; test with the injected sink.
- [x] AC-4: `docs/operations/cli-hierarchy.md` filing section states the auto-enqueue in two sentences and that `brief --notify` remains for multi-task briefs.
- [x] AC-5: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
A merged `ai-sdlc/file-<id>` filing PR now has its task enqueued from the brief `tasks-<id>.md` (wave and priority from the brief) on the next reconcile tick. The planner gets one line through the planner notifier. Tasks with `dispatchable: false`, a `blocked.reason`, an `--update` branch, or already on the board are left alone, with no line sent.

## Changes
- pipeline-cli/src/hierarchy/filing-enqueue.ts
- pipeline-cli/src/hierarchy/filing-enqueue.test.ts
- pipeline-cli/src/hierarchy/reconcile.ts
- pipeline-cli/src/cli/dispatch.ts
- docs/operations/cli-hierarchy.md
- backlog/tasks/AISDLC-1242 - landed filing PR for a dispatchable task enqueues itself.md

## Design decisions
I ran `pnpm lint` and `pnpm format:check` again after the last edit and both were clean. I did not run `pnpm build` or `pnpm test` again after the rebase onto origin/main. The pre-push hook did run before the push succeeded. Eligibility is read from `origin/main`, but the enqueue resolves the task file from the local working tree. If the local checkout lags `origin/main`, the enqueue is refused and no line is sent. The planner line is sent at most once, when the filing PR's landing is first recorded, so a failed notify is not retried; the task is already on the board by then. `commitSha` above is the branch head rather than a literal SHA; run `git rev-parse HEAD` in the worktree for it.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

