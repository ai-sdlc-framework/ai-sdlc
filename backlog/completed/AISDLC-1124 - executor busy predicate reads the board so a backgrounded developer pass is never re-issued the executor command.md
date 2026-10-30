---
id: AISDLC-1124
title: executor busy predicate reads the board so a backgrounded developer pass is never re-issued the executor command
status: Done
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

- [x] Unit test: with an inflight manifest naming the worker and a backgrounded developer (main turn ended), a `session.start`, an `enqueue` wake and a `rotate` wake each produce no command run and one logged skip.
- [x] Unit test: a `session.start` carrying an `agentId` never runs the pinned start.
- [x] Unit test: `clearExecutor` and the stall reaper refuse a worker named by the inflight manifest with a heartbeat younger than 30 minutes even when the pane shows a prompt and the registry says idle.
- [x] The module store holds one line per wake decision naming the worker, the event and the reason.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.

## Out of scope

- Dispatch-side wake fan-out and the pre-spawn eligibility check (AISDLC-1121).
- Heartbeat-age reaping thresholds (AISDLC-1103).

## Final Summary

## Summary
The executor hooks module now decides busy from the board. The pinned start, the enqueue wake and the rotate paths skip while an inflight manifest or a heartbeat under 30 minutes names the worker. A `session.start` with an `agentId` returns before any check, and every wake decision is logged to the module store. The stall reaper no longer reaps an idle holder early, and `clearExecutor` already refused any inflight holder.

## Changes
- ai-sdlc-plugin/hooks/hierarchy/executor.ts
- ai-sdlc-plugin/hooks/hierarchy/register.tsx
- ai-sdlc-plugin/mods/tests/hierarchy.test.ts
- pipeline-cli/src/hierarchy/stall.ts
- pipeline-cli/src/hierarchy/stall.test.ts
- pipeline-cli/src/hierarchy/clear.test.ts
- pipeline-cli/src/hierarchy/dispatch-loop.test.ts
- docs/operations/cli-hierarchy.md

## Design decisions
Test command: `env -u AI_SDLC_EXECUTOR_TASK pnpm test`, exit 0 (pipeline-cli 12426 passed, orchestrator 5242 passed, plugin mods 102 passed). I unset `AI_SDLC_EXECUTOR_TASK` because my shell had it set, and it made the pipeline-cli `executor-start` tests fail. Choices to check: (1) 'rotate wake' in AC1 is read as the clear path, meaning the rotations in `turn.complete` and `session.measure`. The dispatch-sent `rotate` message is already unhandled (AISDLC-1107) and still passes through. (2) The stall reaper now reaps `holder-not-busy` only for `gone` or `unknown` holders. An `idle` holder waits for the 30 minute stale threshold. I left the `holder-asked-question` path as is. (3) The module reads the board through `$.process.run node -e` because it has no fs access. If that call fails, the predicate reads as not held, which is the old behaviour. (4) For the clear half of AC3, I changed only the test title, because the existing test already covered a fresh-heartbeat inflight holder.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

