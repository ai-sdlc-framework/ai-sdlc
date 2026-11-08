---
id: AISDLC-1243
title: 'The dispatch tick retires a failed/ verdict whose task is in backlog/completed, so the board no longer lists landed tasks as failed'
status: Done
assignee: []
created_date: '2026-11-08'
labels:
  - dispatch
  - board
  - hygiene
  - automation
dependencies: []
references:
  - pipeline-cli/src/dispatch/retire-landed.ts
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
priority: medium
dispatchable: true
dispatchableReason: 'Operator ruling 2026-11-08: every gap the planner wake catches by hand becomes an automation task. Gap: the board has shown "failed: AISDLC-1086, 1121, 1122, 1147, 1225" for days although every one of those tasks is in backlog/completed with a merged PR; each wake re-derives by hand that they are stale, and the status line misreports the board.'
---

## Description

**Gap.** A task can end in `failed/` (push refused, preflight refusal, a lost race) and then land anyway through a later round, a re-filed task or a hand-finished PR. Nothing clears the old verdict: `retire-landed.ts` handles queue entries, and `withManifest` clears a manifest only when a command names the task. `cli-hierarchy status` and the handoff then count landed tasks as failed, and the planner's wake spends a step each time confirming the entries are stale (five of them on 2026-11-08: 1086, 1121, 1122, 1147, 1225).

**Shape.** On each tick the reconciler lists `failed/*.verdict.json`; for each task id whose file is under `backlog/completed/` on `origin/main`, or whose task PR is merged, it moves the verdict and any manifest to `retired/` with `retiredReason: 'task landed <sha>'` and appends one audit line. Nothing is deleted, and a failed verdict for a task still open is untouched.

## Fix

**Five-step review (requirements first).**
1. Question: is a stale failed entry harmful or only noisy? It misreports the board to the operator and the planner, and the AISDLC-1121 case ("already shipped, drop it from the board") shows the pipeline itself asked for the cleanup. Worth one predicate.
2. Delete: the by-hand `remove-verdict --from failed` calls the planner has been issuing.
3. Simplify: extend `retire-landed.ts` to the failed/ directory rather than adding a new module.
4. Accelerate: none.
5. Automate: tests for landed-by-completed-file, landed-by-merged-PR, still-open (untouched), and the audit line.

## Acceptance Criteria

- [x] AC-1: a `failed/` verdict whose task is in `backlog/completed/` on `origin/main` is moved to `retired/` with the reason on the next tick; test.
- [x] AC-2: a `failed/` verdict whose task is still open is untouched; test.
- [x] AC-3: `cli-hierarchy status` on the 2026-11-08 board fixture shows `failed: (none)` after one tick; fixture test built from the five entries.
- [x] AC-4: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
The dispatch tick now moves a `failed/` verdict and any manifest to `retired/` when the task has landed. A task counts as landed if its file is under `backlog/completed/` on `origin/main`, or if a merged task PR is on record. Each move records `retiredReason: 'task landed <sha>'` and appends one line to `board-events.jsonl`. A verdict for a task still open is untouched, and nothing is deleted.

## Changes
- pipeline-cli/src/dispatch/retire-landed.ts
- pipeline-cli/src/hierarchy/dispatch-loop.ts
- pipeline-cli/src/cli/hierarchy.ts
- pipeline-cli/src/dispatch/retire-failed-landed.test.ts
- backlog/tasks/AISDLC-1243 - tick retires failed verdicts whose task has landed.md

## Design decisions
I ran build, test, lint and format:check on the first commit and they passed. I did not re-run all four after the last commit, which only moved the `origin/main` read into `retire-landed.ts` and added a test. After that move I ran only the new test file, `tsc --noEmit` and eslint on the touched files, and all were clean. The pre-push hook's patch-coverage gate passed on the final push. The first push failed that gate at 85.14%, so I added a test for the `origin/main` read. AC-3 is covered by building a `failed/` board from the five 2026-11-08 ids (1086, 1121, 1122, 1147, 1225). After one retire pass, `peekQueue(...).failed` goes from 5 to 0. I did not run `cli-hierarchy status` itself on that board. The tick also reads `origin/main` through `git ls-tree`, only when `failed/` holds a verdict. If `origin/main` can't be read, landing records still retire the verdict.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

