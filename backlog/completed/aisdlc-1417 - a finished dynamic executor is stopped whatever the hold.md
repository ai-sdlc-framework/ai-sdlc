---
id: AISDLC-1417
title: "A finished dynamic executor is stopped on its verdict, whatever the hold: teardown has one owner and no hold gates it"
status: Done
priority: high
labels:
  - pipeline-cli
  - hierarchy
  - bug
dependencies: []
references:
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/ephemeral-tick.ts
  - pipeline-cli/src/hierarchy/down.ts
  - pipeline-cli/src/hierarchy/status.ts
  - docs/operations/cli-hierarchy.md
---

## Description

**Five-step review (requirements first).**
1. Question: operator, 2026-11-26: "we need to handle the termination state correctly for dynamic executors; this has been a persistent issue." Live case: `ai-sdlc-executor-aisdlc-1423` started 16:52:09Z, a planner hold was set 16:52:22Z, the verdict (success) was written 17:32:25Z, PR #3049 merged 17:52Z, and at 18:12Z the roster still showed the executor `running`/idle at 116k context; the planner stopped it by hand. Root cause (verified): `runEphemeralSteps` returns early on any hold, `dispatch-loop.ts:837` `if (!eph || held) return { stalled: await reap() };`, which skips `downRecordedExecutors` (ephemeral-tick.ts ~95-106), the backstop `sweepFinishedExecutors` (ephemeral-tick.ts ~112-137) and orphan reaping; `watchVerdicts` is also hold-gated (~639-650), so the verdict is not marked handled and the clear is skipped ("the board is held"). Any executor in flight when a hold is set is orphaned by construction. The guard has existed since AISDLC-1074 introduced down-on-verdict; later fixes (AISDLC-1103, 1117, 1252, 1218, 1083, 1099) each patched one trigger (heartbeat, orphan, surplus, claim) and none removed the guard; AISDLC-1252 recorded the hold interaction and did not address it. A hold is documented to block claims and relaunches only (prompt rule `hold-reporting`, AISDLC-899).
2. Delete: the `held` early return for teardown; the separate "down this tick" path as the primary trigger if the level-triggered sweep can own teardown alone.
3. Simplify: one owner. Teardown is level-triggered from durable facts each tick: a rostered dynamic executor whose task has a verdict newer than its `startedAt`, and no inflight claim, is downed. No hold, budget-pacer hold or quota skip gates it; only spawn and claim are gated. Remove the 5-minute grace if nothing needs it (state why if kept). Verdict consumption for a success outcome (mark handled, down) is hold-independent; the held-only behaviour for failures (no failure playbook, one planner notice, AISDLC-1382) stays.
4. Accelerate: none.
5. Automate: `cli-hierarchy status` flags a rostered dynamic executor with a verdict older than 10 minutes as `finished, not stopped` instead of `idle`, so a missed teardown is visible.

## Acceptance Criteria
- [ ] #1 A test: board held, rostered dynamic executor with a success verdict newer than its `startedAt` and no inflight manifest; one dispatch tick downs it (roster entry removed, `down` called) and marks the verdict handled. Fails on main.
- [ ] #2 A test: same while a budget-pacer hold and a quota skip are active; the executor is downed. Claims and spawns are still skipped under each hold (existing tests unchanged).
- [ ] #3 A test: an executor with an inflight claim, or whose verdict predates its `startedAt`, is not downed under any hold.
- [ ] #4 Orphan reaping and `downIdleSurplus` run under a hold (test).
- [ ] #5 A failed verdict under a hold keeps today's behaviour (no playbook, one planner notice) but the executor is still stopped once its verdict is recorded; state in the PR body whether a failed executor is downed or kept for inspection, and why.
- [ ] #6 `cli-hierarchy status` shows `finished, not stopped` for a rostered dynamic executor whose verdict is over 10 minutes old (test).
- [ ] #7 `docs/operations/cli-hierarchy.md` states the termination rule (one owner, level-triggered, not gated by any hold) and lists what a hold gates.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
