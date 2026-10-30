---
id: AISDLC-1124
title: executor busy predicate reads the board so a backgrounded developer pass is never re-issued the executor command
status: To Do
assignee: []
created_date: '2026-10-30'
labels:
  - hierarchy
  - velocity
priority: high
references:
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - ai-sdlc-plugin/hooks/hierarchy/register.tsx
  - pipeline-cli/src/hierarchy/clear.ts
  - pipeline-cli/src/hierarchy/stall.ts
  - docs/operations/cli-hierarchy.md
---

## Description

On 2026-10-30 ~21:05Z the executor session holding a task received a second `/ai-sdlc:executor` while its developer subagent was still running in the background (context at 11 percent, no verdict on the board). The model spent a turn refusing: "I'm not starting a second claim. I already hold the task and the pipeline is mid-run". The cause is how the hooks module decides an executor is busy. Every signal it uses describes the main turn, not the task: the in-memory `active` flag that `executorTurnComplete` clears at the end of each main turn, the registry `idle` status, and the pane check that looks for an "esc to interrupt" line. When the developer agent is backgrounded, the main turn ends at once and all three read idle for the whole developer pass, while the board still holds the inflight manifest and a fresh heartbeat for this worker.

Two paths in the executor module re-issue the command on that false idle: the pinned start on `session.start` (guarded only by `resumePending`, never by the inflight manifest, and not skipping events that carry an `agentId`), and the enqueue wake (guarded by the cleared `active` flag). The post-verdict clear and the stall reaper share the same pane and registry blind spot; today only the inflight file keeps them off a running executor. No wake or clear event is written to the module store, so the trigger could not be confirmed from a log.

**Five-step review (requirements first).** Requirement questioned: must "busy" mean the main turn is open? No: busy means the board names this worker as the holder of a task. Deletion: delete the clearing of `active` at turn end while a background agent is pending; delete the turn-state guards in favour of the board. Simplified: one predicate, "the inflight manifest or heartbeat names this worker", shared by the pinned start, the enqueue wake, the clear and the stall reaper. Accelerated: a `session.start` that carries an `agentId` returns before any check. Automated: wake and clear decisions are written to the module store so the next incident has a log.

## Fix

1. `ai-sdlc-plugin/hooks/hierarchy/executor.ts`: add `holdsTask(workerName)` that reads the board (`inflight/<task>.dispatch.json` worker or the heartbeat `workerId`). The pinned start, the enqueue wake and the rotation decision use it; `executorTurnComplete` no longer sets `active` to false while a background agent is pending. Log every skipped or taken wake with its reason to the module store.
2. `ai-sdlc-plugin/hooks/hierarchy/register.tsx`: `session.start` events with an `agentId` (subagent starts) never reach `startPinnedTask`.
3. `pipeline-cli/src/hierarchy/clear.ts` and `stall.ts`: the pane-idle check also consults the same holder predicate, so a backgrounded developer pass is never cleared or reaped on pane or registry state alone; the 30-minute hard heartbeat age stays as the only override.
4. `docs/operations/cli-hierarchy.md`: one paragraph on the busy predicate and the wake log.

## Velocity impact

Removes one wasted model turn per wake on a running executor and prevents a future clear or reap of a live developer pass; no change to how fast an idle executor is woken.

## Acceptance Criteria

- [ ] Unit test: with an inflight manifest naming the worker and a backgrounded developer (main turn ended), a `session.start`, an `enqueue` wake and a `rotate` wake each produce no command run and one logged skip.
- [ ] Unit test: a `session.start` carrying an `agentId` never runs the pinned start.
- [ ] Unit test: `clearExecutor` and the stall reaper refuse a worker named by the inflight manifest with a heartbeat younger than 30 minutes even when the pane shows a prompt and the registry says idle.
- [ ] The module store holds one line per wake decision naming the worker, the event and the reason.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.

## Out of scope

- Dispatch-side wake fan-out and the pre-spawn eligibility check (AISDLC-1121).
- Heartbeat-age reaping thresholds (AISDLC-1103).
