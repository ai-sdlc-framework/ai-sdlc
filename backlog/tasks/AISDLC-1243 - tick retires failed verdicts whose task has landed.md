---
id: AISDLC-1243
title: 'The dispatch tick retires a failed/ verdict whose task is in backlog/completed, so the board no longer lists landed tasks as failed'
status: To Do
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

- [ ] AC-1: a `failed/` verdict whose task is in `backlog/completed/` on `origin/main` is moved to `retired/` with the reason on the next tick; test.
- [ ] AC-2: a `failed/` verdict whose task is still open is untouched; test.
- [ ] AC-3: `cli-hierarchy status` on the 2026-11-08 board fixture shows `failed: (none)` after one tick; fixture test built from the five entries.
- [ ] AC-4: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
