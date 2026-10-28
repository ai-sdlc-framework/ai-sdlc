---
id: AISDLC-1102
title: 'hierarchy loop canary: a scheduled synthetic docs-only task flows claim, develop, verdict, clear and re-claim through the live hierarchy with a per-stage deadline, and a missed stage is a board failure'
status: To Do
assignee: []
created_date: '2026-10-28'
labels:
  - orchestrator
  - hierarchy
priority: high
dispatchable: true
dependencies:
  - AISDLC-1089
  - AISDLC-1099
  - AISDLC-1100
references:
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - ai-sdlc-plugin/commands/executor.md
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - docs/operations/cli-hierarchy.md
---

## Description

Observed 2026-10-28: four independent breaks in the executor lifecycle (verdict marker never matched the turn payload, rotate request to an idle executor never read, executor status line not classified as a verdict, context measurement read as 0) had all been live for days with every unit test green and MODULE showing `loaded`. Each was found by a human reading logs after a stall. The existing post-merge pipeline canary (completed earlier) exercises CI on main, not the session hierarchy: no automated check ever drives a task through claim, developer, verdict, clear and the next claim on the live roster.

## Fix

**Five-step review (requirements first).** The requirement questioned is "unit tests on each hook prove the loop works": the breaks were all at the seams between host, module, board and roster, which only an end-to-end run crosses. Nothing to delete. Simplified: one synthetic task definition (docs-only, one-line change under `docs/operations/canary/`, auto-closed PR path or a no-PR mode) reused on every run. Accelerated: each stage transition stamps the board state file, and the first missed deadline fails the run, so a broken seam is named within minutes of a module change rather than after a day of tracing. Automated: scheduled by the dispatch tick (default once per day and once after every relaunch of the hierarchy), result written as a board record.

1. `cli-hierarchy canary run [--no-pr]` enqueues a synthetic task `AISDLC-CANARY-<timestamp>` on the board with a fixed body (edit one timestamp line under `docs/operations/canary/last-run.md`). In `--no-pr` mode the developer stage commits in the worktree and skips push and PR; the default mode opens the PR as a normal docs-only task.
2. The tick stamps the canary state file at each transition: `claimed`, `developerStarted`, `verdictWritten`, `executorCleared`, `executorReclaimed` (the same executor, or any idle one, claims the next eligible task or the canary's own follow-up stub). Each stage has a deadline (defaults: claim 5 min, develop 15 min, verdict 5 min, clear 5 min, re-claim 5 min).
3. A missed deadline writes `<board>/failed/canary-<timestamp>.verdict.json` naming the last stage reached and the stage that timed out, sends the planner one line, and `cli-hierarchy status` shows `CANARY: failed at <stage>`; a full pass writes the record to `done/` and status shows `CANARY: pass <time>`.
4. Scheduling: the dispatch module runs the canary once after `cli-hierarchy up` finishes launching the roster and once per day at a configurable time; `canary run` is also available by hand. The canary never runs while a hold is active or while any real task is inflight on the executor it would use, and it is removed from the board and the worktree swept when it ends.
5. Tests: (a) stage stamps in order produce a pass record; (b) a missing stamp past its deadline produces a failure record naming the stage; (c) the canary refuses to start under a hold; (d) the synthetic task is never counted in the done or failed totals of real work (separate `canary/` subfolder or a `kind: canary` field the counters skip).
6. `docs/operations/cli-hierarchy.md`: document the canary, its stages, deadlines and how to read a failure.

## Acceptance Criteria

- [ ] `cli-hierarchy canary run --no-pr` on a live roster completes all five stages and writes a pass record within the default deadlines.
- [ ] Stopping the executor clear path (simulated by a fixture that never writes the clear stamp) produces a failure record naming `executorCleared` and a planner message.
- [ ] The canary runs after `up` and daily without operator action and never under a hold.
- [ ] Canary records are excluded from the board's real done and failed counts.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
