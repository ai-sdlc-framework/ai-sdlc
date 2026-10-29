---
id: AISDLC-1110
title: >-
  cli-hierarchy restart accepts the planner session as caller when dispatch has not acted on a restart request within two ticks, and dispatch acts on planner restart requests deterministically from the tick
status: To Do
assignee: []
created_date: '2026-10-29'
labels:
  - hierarchy
  - dispatch
  - stability
dependencies: []
references:
  - pipeline-cli/src/hierarchy/restart.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Overnight 2026-10-29 the operator authorized the planner to restart hierarchy sessions as needed, especially over-context ones. At 08:15Z the drain stalled: 0 inflight, 18 queued, executors alpha, gamma and delta in state `unknown` with no task, dispatch ticking. The planner ran `cli-hierarchy restart ai-sdlc-executor-alpha` (and gamma, delta) and was refused: `only the dispatch session may run this command (the caller's role is planner); run it from the dispatch session in the main checkout, or ask the dispatch session to run it`. The planner had already asked the dispatch session by `cli-hierarchy send` four times between 06:18Z and 07:47Z (planner over its 150k clear threshold since 06:15Z, now 197k) and once at 08:17Z for the executors; no request was acted on. Dispatch's tick is module-driven and does not read planner messages as instructions, so "ask the dispatch session" is not a path that works unattended. The only sanctioned restart path was the operator, who was away.

**Five-step review (requirements first).** Requirement questioned: "only dispatch restarts sessions, because two restarters could race on the same pane". A race is prevented by a lock, not by a role check; and a restart is idempotent (kill + relaunch) so a double restart costs one relaunch, while a missing restart costs the whole night's drain. Deleted: the role check as the sole guard. Simplified: `restart` takes a per-session lock file under the board dir; any roster session (dispatch, planner, operator shell) may call it; a second caller inside the lock window is refused with the holder's name. Accelerated: the dispatch tick restarts an executor in `unknown` or `idle after verdict` state for two consecutive ticks on its own (same deterministic path as AISDLC-1107's verdict-driven clear), and restarts the planner when its measured context is over threshold for two ticks, so the planner never needs to ask. Automated: a `restart-request` board file written by `cli-hierarchy send --restart <name>` (or by the planner tick) is consumed by the next dispatch tick as a deterministic action, with the outcome logged in `status`; the planner's direct call stays as the fallback when the tick is dead.

Fix: lift the role check in `pipeline-cli/src/hierarchy/restart.ts` / `cli/hierarchy.ts` to a lock; add the two-tick auto-restart rules and the request-file consumption to `dispatch-loop.ts`; document the three paths in `docs/operations/cli-hierarchy.md`. Self-restart of the calling session remains refused (the 22:57Z outage class).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `cli-hierarchy restart <executor>` from a planner-role session succeeds when no other caller holds the session's restart lock, and is refused naming the holder otherwise (test).
- [ ] A caller restarting its own session is refused (test).
- [ ] The dispatch tick restarts an executor that is `unknown` with no task, or idle after verdict, on the second consecutive tick, and logs it (test with a fake pane driver).
- [ ] The dispatch tick restarts a roster session whose measured context is over its clear threshold on the second consecutive tick, planner included (test).
- [ ] A restart-request board file written by the planner is consumed by the next tick as a restart and removed (test).
- [ ] `docs/operations/cli-hierarchy.md` documents the lock, the auto-restart rules and the request file.
- [ ] `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.

## Notes

Evidence: `cli-hierarchy status` 08:15Z (0 inflight, three executors `unknown`, planner `197k OVER`, dispatch `last tick: 11s ago by host`); planner `send` log 06:18Z, 07:05Z, 07:17Z, 07:47Z, 08:17Z; refusal text above. Related: AISDLC-1104 (restart verb), AISDLC-1107 (verdict-driven clear), AISDLC-1101 (stall detection).
