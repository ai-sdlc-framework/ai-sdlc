---
id: AISDLC-1216
title: 'Executor module publishes executor state to the board on turn and subagent events'
status: To Do
assignee: []
created_date: '2026-11-07'
labels:
  - hooks
  - dispatch
  - dec-0392
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - ai-sdlc-plugin/hooks/hierarchy/register.tsx
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/hierarchy/status.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

**Source.** DEC-0392 (event-driven dispatch liveness), part 1 of 4. Today the executor's hooks module keeps a private `active` flag from `turn.start` / `turn.complete` (`ai-sdlc-plugin/hooks/hierarchy/executor.ts`, `ACTIVE_STALE_MS` 30 min) and drops every `session.start` event that carries an `agentId` (`register.tsx:127`, AISDLC-1124). A backgrounded developer therefore reads as idle and the dispatch tick has no signal other than the heartbeat age in `inflight/<task>.state.json`.

**First step, a check with a documented fallback.** Establish which events the hooks module API delivers for a background `Agent` call in the executor session: a subagent `session.start` with `agentId` is already received and ignored; find whether a matching end event (subagent session end, or the parent `turn.start` carrying the task notification) is delivered. If no end event exists, the fallback is: treat the task-notification turn as the end of the background agent, and keep a per-agentId set so two agents are counted separately. Record the finding in the PR body.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: dispatch needs to know whether an executor is alive and working; the heartbeat age (AISDLC-826, RFC-0041 OQ-3) was a proxy for that, chosen because no event reached dispatch. 2. Deleted: the private `active` flag and its 30-minute `ACTIVE_STALE_MS`; the agentId drop in `register.tsx` becomes a handler. 3. Simplified: the module writes one `executorState` field into the board's `inflight/<task>.state.json` (through a `board.ts` writer next to `writeHeartbeat`, atomic rename) with the values `turn-running`, `background-agent-running` (with the agentId set) and `idle-awaiting-clear`, on the events themselves. `cli-hierarchy status` and `cli-hierarchy inflight` print it. 4. Accelerated: dispatch learns the state on the event, not at the next 30-second tick plus a 30-minute age; AISDLC-1217 and AISDLC-1218 consume it. 5. Automated: nothing new; the stall rule change is AISDLC-1218.

The `.state.json` file stays as the lease-push claim binding (`ai-sdlc-plugin/hooks/lib/trusted-policy.js`); this task adds a field and never deletes the file.

## Acceptance Criteria
- [ ] #1 With a claim held, `turn.start` writes `executorState: turn-running` and `turn.complete` with no background agent writes `idle-awaiting-clear` into the claim's `.state.json` (node --test on the module with a fake board dir).
- [ ] #2 A subagent `session.start` with an `agentId` records the agent and writes `background-agent-running`; its end (per the check above) removes it, and the state returns to the turn state. Two concurrent agents are tracked separately.
- [ ] #3 `cli-hierarchy status` shows the state per inflight task; `docs/operations/cli-hierarchy.md` documents the three values and where they are written.
- [ ] #4 The `active` flag and `ACTIVE_STALE_MS` are removed; no reader remains (dark-code gate green).
- [ ] #5 The PR body records which end event the module API delivers for a background agent, or that the task-notification fallback is used.
