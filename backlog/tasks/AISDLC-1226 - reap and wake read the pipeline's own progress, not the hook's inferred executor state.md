---
id: AISDLC-1226
title: reap and wake read the pipeline's own progress, not the hook's inferred executor state
status: To Do
priority: critical
labels: [bug, hierarchy, dispatch]
dependencies: [AISDLC-1225]
dispatchable: true
---

## Problem

After AISDLC-1225 (#2510, d6d2a3b9) the idle-with-claim reap still fails healthy claims and the enqueue wake still types `/ai-sdlc:executor` into busy panes. Evidence 2026-11-07: AISDLC-705 reaped at 16:12:57Z, 113 s after its claim, step `claimed`, pane showing `Waiting for 1 background agent`; AISDLC-717 claimed 16:12:35Z, `inflight/AISDLC-717.state.json` already `idle-awaiting-clear` at 16:13:00Z while its developer round ran. Under a planner hold (reap blocked) 717 completed normally at 16:30Z.

Root cause is structural, not one more missed branch. The hooks module (`ai-sdlc-plugin/hooks/hierarchy/executor.ts`) infers the executor's state from hook events: a background agent is added on its `session.start` and removed on any `turn.complete` carrying its agentId (line ~638). A background subagent emits `turn.complete` after each of its own turns, so the agent list empties within seconds and `executorBoardState` publishes `idle-awaiting-clear` while the agent is still running. The hook cannot know when the developer round ends; it is a bystander guessing from events, and its agent list lives in memory and is lost on every clear.

The process that does know is the pipeline. `next-step` already writes a real step marker at every boundary (`01-validated`, `05-dev-running`, `06-dev-done`, `07-reviewers-running`, `10-signing`, `11b-pr-opened`) into `sessions/<task>.session.json` via `updateSessionState`, and keeps a `phase` (`awaiting-developer | awaiting-reviewers | done | aborted`) in its durable state. Neither consumer reads either record:

- `reapStalledClaims` (`pipeline-cli/src/hierarchy/stall.ts`) reads only the hook's `executorState`, the `lastHeartbeat` age and the process tree.
- the enqueue wake (`hooks/hierarchy/dispatch.ts` + `executorSessionReceive`) reads the session registry status and `heldTask()`, which only checks that a claim exists with a heartbeat under 30 minutes.

A second defect found while tracing: `ai-sdlc-plugin/commands/executor.md:94` says the pipeline refreshes the claim heartbeat on every step. It does not; nothing under `pipeline-cli/src/next-step/` writes `inflight/*.state.json`, so `lastHeartbeat` stays at claim time and the 1225 floor (30 s from `lastHeartbeat ?? dispatchedAt`) is measured from the claim, not from the last state publish.

## Fix

**Five-step review (requirements first).**
1. Question: the reap exists so a claim whose executor is truly idle is not held forever (DEC-0392, event-driven liveness). The requirement stands. What it does not require is a hook-inferred state; it requires a true one.
2. Delete: remove the agent-tracking fields (`agents`, `turnInFlight` as a board signal), `executorBoardState`, `PUBLISH_SCRIPT` and the `executorState` field they publish. Remove the 1225 floor, which only papered over the wrong signal. The hook no longer publishes executor state at all.
3. Simplify: the pipeline is the single writer of progress. In `next-step`, where `updateSessionState` already runs at each step boundary, also refresh `inflight/<task>.state.json` (`writeHeartbeat`: `currentStep` = the step marker, `lastHeartbeat` = now). This makes the documented heartbeat true. `executor-start` keeps writing the initial `claimed` record.
4. Accelerate: the reap rule becomes: a claim is idle-with-claim only when (a) its phase is `done` or `aborted` with no verdict written, or (b) `lastHeartbeat` is older than a stall window measured in minutes (default 20 min; a configurable `stallMs` in `StallDeps`), and in both cases `hasLiveNextStep` is false. The wake rule becomes: `executorSessionReceive` skips any executor holding a claim whose phase is not terminal, regardless of heartbeat age; `heldTask()` reads the phase, not a 30-minute heartbeat guess.
5. Automate last: nothing new; the 30 s tick already runs both consumers. Update `docs/operations/cli-hierarchy.md` (the AISDLC-1225 paragraph, lines ~292-300) and `commands/executor.md:94` to describe the pipeline-written heartbeat.

The alternative considered and rejected: keep the hook state and end a background agent only on the task notification naming it. It fixes today's symptom but leaves a second, lossy source of truth in memory that every future hook event can corrupt.

## Acceptance Criteria

- [ ] #1 Test: `next-step` advancing through `05-dev-running`, `06-dev-done` and `07-reviewers-running` refreshes `inflight/<task>.state.json` with the step marker and a fresh `lastHeartbeat` each time.
- [ ] #2 Test: `reapStalledClaims` spares a claim whose phase is `awaiting-developer` and whose heartbeat is 2 minutes old; reaps a claim whose phase is `done` with no verdict and no live `next-step`; reaps a claim with heartbeat older than `stallMs` and no live `next-step`; the AISDLC-1218 idle-no-verdict case still reaps.
- [ ] #3 Test: an enqueue wake delivered to an executor holding a claim in phase `awaiting-developer` is a skip, even when the executor's turn is not in flight and the heartbeat is older than 30 minutes.
- [ ] #4 `executorState`, `executorBoardState`, `PUBLISH_SCRIPT` and the 1225 floor are gone; `pnpm dark-code:check` passes without a baseline growth.
- [ ] #5 `docs/operations/cli-hierarchy.md` and `ai-sdlc-plugin/commands/executor.md` describe the pipeline-written heartbeat and the two reap conditions.

## Notes

Depends on AISDLC-1225 only for file context (same functions). Until this lands the planner hold stays; like 1225, this task must be run by hand outside the dispatch tick or under the hold, because the reap it fixes kills its own claim.
