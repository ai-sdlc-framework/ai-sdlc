---
id: AISDLC-1225
title: idle-with-claim reap must not fire while a background developer agent runs
status: In Progress
priority: critical
labels: [bug, hierarchy, dispatch]
dependencies: [AISDLC-1218, AISDLC-1216]
dispatchable: true
---

## Problem

Since AISDLC-1218 (#2499, 470d40c2) the dispatch tick reaps any inflight claim whose published `executorState` is `idle-awaiting-clear` and that has no verdict, with no grace period. Within 15 minutes of landing it failed two fresh claims that were doing real work:

- AISDLC-515.1 (`failed/AISDLC-515.1.diagnostic.json`, 06:45Z, heartbeat 71s old, step `claimed`)
- AISDLC-731 (`failed/AISDLC-731.diagnostic.json`, 06:49Z, heartbeat 38s old, step `claimed`)

Both panes were showing `Waiting for 1 background agent to finish` (the developer subagent) when the reap fired. The published state was wrong, not the executor.

Root cause, in `ai-sdlc-plugin/hooks/hierarchy/executor.ts`:

1. `executorBoardState` returns `background-agent-running` only while `state.agents` is non-empty.
2. `endBackgroundAgent` empties `state.agents` on **every** parent `turn.start` whose text is not a task notification (comment: "foreground subagents never signal an end, so none is live"). An executor whose developer runs in the background regularly gets a non-notification parent turn (a dispatch status line, a `held for planner` line, the module's own wake or resume), which wipes the list while the agent is still running. When that turn completes, the module publishes `idle-awaiting-clear` and the next tick reaps the claim.
3. The reap's only sparing probe is `hasLiveNextStep` (a `next-step` process under the pane); an in-session `Agent` developer round is not a `next-step` process, so nothing spares it.

Secondary defect seen on the 731 pane: the clear issued after the reap sent `/exit`, which stopped on the host's "Background work is running: 1. Exit and stop tasks 2. Move to background 3. Stay" dialog. The pane is stuck, the developer keeps running in `.worktrees/aisdlc-731`, and the roster still lists the executor as busy.

## Fix

**Five-step review (requirements first).**
1. Question: DEC-0392 wants the liveness rule event-driven; it does not want a wrong event to fail a healthy claim. The requirement stands; the published state must be true.
2. Delete: remove the "non-notification turn empties the agent list" branch in `endBackgroundAgent`. A background agent ends only on its own end event (the `agentId` branch that already exists near line 642) or on the task notification that names it.
3. Simplify: keep `executorBoardState` as is; it is correct once the list is correct.
4. Accelerate: in `reapStalledClaims`, add a second sparing probe for an executor pane whose host reports a running background agent (the same mechanism the `/exit` dialog uses), or, if no such probe exists, a short floor: a claim is not reaped while its last state publish is younger than one tick interval. State in the PR which one was chosen and why.
5. Automate: the clear path must never leave a pane on the exit confirm dialog: when a background agent is live, the clear either waits for the agent to end or stops it explicitly, never sends a bare `/exit`.

## Acceptance Criteria

- [ ] #1 Test: an executor whose `state.agents` holds one id receives a parent `turn.start` with non-notification text; after the turn completes the published state is still `background-agent-running`, and the list empties only on the agent's own end event or the task notification naming it.
- [ ] #2 Test: `reapStalledClaims` does not reap a claim whose published state flipped to `idle-awaiting-clear` while the host still reports a live background agent (or whose last state publish is younger than the floor, whichever option step 4 chose); the existing AC-2 of AISDLC-1218 (idle, no agent, no verdict → reaped) still passes.
- [ ] #3 The clear issued after a reap never lands on the "Background work is running" dialog: a test on the clear path shows the agent stopped or awaited before the pane is exited.
- [ ] #4 `docs/operations/cli-hierarchy.md` states when a background agent is considered ended, citing DEC-0392 and this task.
- [ ] #5 The two diagnostics named above are cited in the PR body as the reproduction, and 515.1 and 731 are re-enqueued by dispatch after the fix lands (dispatch action, noted in the PR).

## Notes

Reproduction evidence: `failed/AISDLC-515.1.diagnostic.json`, `failed/AISDLC-731.diagnostic.json`, tmux pane `ai-sdlc-executor-aisdlc-731` captured 06:51Z. The planner held the drain at 06:51Z (`cli-hierarchy hold`) until this lands.
