---
id: AISDLC-1101
title: 'dispatch tick detects a drain stall (eligible queued work, an idle executor, no claim for N minutes) as a board failure that names the stalled stage and reports it to the planner'
status: To Do
assignee: []
created_date: '2026-10-28'
labels:
  - orchestrator
  - hierarchy
priority: high
dispatchable: true
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/status.ts
  - docs/operations/cli-hierarchy.md
---

## Description

Observed 2026-10-28: the drain stalled twice (about 09:00Z and about 17:00Z) with 84 to 87 tasks queued and every executor idle after reporting its verdict. Nothing in the hierarchy noticed. `cli-hierarchy status` showed every row `busy`, MODULE `loaded` and the board counts unchanged; the stall was found by a human comparing two status outputs an hour apart. The tick in `ai-sdlc-plugin/hooks/hierarchy/dispatch.ts` has no notion of "nothing moved": it ingests events, wakes executors only when it ingested something, and ends. A stall is a silent no-op per tick.

Every break found that day (marker never matched, rotate flag never read, status line not classified, measure payload read as 0) produced the same visible symptom, a stall, and none produced a record. One detector covers the whole class.

## Fix

**Five-step review (requirements first).** The requirement questioned is "a healthy tick is one that ran without error": a tick that runs while eligible work and idle capacity coexist for longer than one claim should take is a failure of the drain, whatever its cause. Nothing to delete. Simplified: one rule computed from board and roster state the tick already holds (eligible queued count, idle executors with no inflight task, timestamp of the last claim or verdict). Accelerated: the stall is named at the first tick past the deadline, not an hour later. Automated: the record is written to the board and messaged to the planner by the tick itself; no survey needed.

1. The tick records `lastProgressAt` in the dispatch state file whenever a claim, verdict or ingest happens.
2. On every tick, when eligible queued work is above zero, at least one roster executor is idle with no inflight task, and `now - lastProgressAt` exceeds `stallAfterMinutes` (default 15, configurable in the hierarchy section of the dispatch config), the tick writes `<board>/failed/drain-stall-<timestamp>.verdict.json` with the stage it can prove: `no-claim` (idle executor, eligible work, no claim), `no-clear` (verdict in done or failed for a task an executor still lists as inflight), `no-wake` (idle executor, enqueue sent, no session.start within the deadline). One record per stall, not one per tick: the tick checks for an open stall record first.
3. The same tick sends the planner one line: `drain stall <stage> since <time>: <n> eligible, idle <names>` through the roster send path, and `cli-hierarchy status` prints a `STALL` line under `board:` while the record is open.
4. The record closes (moved to `done/`) by the first tick that observes progress again.
5. Tests: (a) eligible work plus idle executor past the deadline writes exactly one record and one message; (b) the same state inside the deadline writes nothing; (c) a second tick past the deadline does not duplicate the record; (d) progress closes the record; (e) each of the three stage classifications from a fixture board.
6. `docs/operations/cli-hierarchy.md`: document the stall record, the stages and the config key.

## Acceptance Criteria

- [ ] A board with eligible work and an idle executor and no progress for longer than `stallAfterMinutes` produces one `drain-stall` record and one planner message naming the stage.
- [ ] `cli-hierarchy status` shows the open stall.
- [ ] Progress closes the record without operator action.
- [ ] No record is written while the drain is moving or while a hold is active.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
