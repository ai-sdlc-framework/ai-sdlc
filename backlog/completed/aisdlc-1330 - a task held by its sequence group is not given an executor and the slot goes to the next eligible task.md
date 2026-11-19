---
id: AISDLC-1330
title: 'A task held by its sequence group is not given an executor and the slot goes to the next eligible task'
status: Done
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - hierarchy
  - adopter
dependencies: []
references:
  - pipeline-cli/src/hierarchy/ephemeral-tick.ts
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/hierarchy/dispatch-loop-ephemeral.test.ts
  - pipeline-cli/src/dispatch/board-ordering.test.ts
priority: high
dispatchable: true
dispatchableReason: 'Bounded to the start selection in one file, one list field in the board reader and their tests.'
---

## Description

**Gap.** The dispatch tick starts one executor per queued task, in priority order, up to the cap. It does not look at the sequence group of the tasks it picks. When several queued tasks share a group and none is running yet, all of them look eligible, so each gets an executor. Only one can claim. The others are refused with a sequence group message, give the slot back and are started again on a later tick with the same result. Meanwhile an eligible task with no group waits for a slot it never gets.

What was seen in an adopter project on plugin 0.42.0 (reported 2026-11-19): three priority 1 tasks shared one `sequenceGroup`. An executor was started for each. One claimed. The other two failed `executor-start` with "blocked by ... its sequence group" and were started again four minutes later with the same result. Eligible tasks with no group, one of them priority 1, got no executor. The workaround was an explicit `after` chain inside each group, which the start selection does respect.

**Cause (read from the source).**

- `spawnForEligibleClaims` walks `peekQueueOrder(...)` and calls `deps.spawn` for every entry until the slots run out; it never looks at a group (`pipeline-cli/src/hierarchy/ephemeral-tick.ts:150-199`, loop at 182-199).
- `peekQueueOrder` returns task id, wave, priority and time only; the group is dropped (`pipeline-cli/src/dispatch/board.ts:1143-1156`).
- The group rule in `checkEligibility` counts only a group that has an inflight manifest (`board.ts:388-394`, `busyGroups` built at 333-338). Queued siblings, and executors started but not yet claimed, do not count, so every queued member passes.
- The claim does enforce one holder per group: a spawned executor is pinned to its task, `claimNext` hands the claim back when a rival holds the group or has a lower task id (`board.ts:586-592`, `settleGroupClaim` at 650-664), and `executorStart` then throws "cannot claim ... blocked by a dependency or its sequence group" (`pipeline-cli/src/hierarchy/executor-start.ts:203-207`). The refused task returns to the queue, so the next tick picks it again.
- `claimNext` itself tries only the first eligible manifest of a group (`board.ts:559-564`); the start selection has no such rule.

**Shape.** The start selection applies the claim's own rule. Walking the queue in order, it gives an executor to the first task of each sequence group and skips the other queued members of that group. A group already held by an inflight task, or by an executor started this or an earlier tick for a task of that group, is skipped too. A skipped task keeps its slot free for the next eligible task, and costs no session start.

**Control.** No control changes. The claim still enforces one holder per group; the start selection stops asking for starts the claim must refuse.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: "start an executor for every queued task" assumes the claim will accept each one; a sequence group says it will not. 2. Deleted: the refused start and its four-minute retry for a task that cannot claim. 3. Simplified or optimised: reuse the order and the group already known to the board reader; no new rule, only the claim's rule applied one step earlier. 4. Accelerated: the freed slot goes to the next eligible task on the same tick. 5. Automated: a test that fails when the start selection spawns two tasks of one group.

- **Group in the queue order.** `peekQueueOrder` entries carry the task's `sequenceGroup` when it has one.
- **Start selection.** In `spawnForEligibleClaims`, skip a task whose group was already chosen in this pass, or whose group is held by a live spawned executor's task or an inflight manifest. A skipped task does not use a slot. A task with no group is unaffected.
- **Tests.** Cover the cases in the criteria.

Out of scope: how a group is assigned in the brief; the claim, its settle step and its error text; the cap and the open-PR hold; the retry timing of a failed start for other causes; the blockers list that disagrees with the board (AISDLC-1341).

## Acceptance Criteria

- [ ] #1 A test queues three tasks of one group with priorities 1, 1, 2 and one task with no group at priority 2, cap 3: exactly one task of the group and the ungrouped task are started, and the other two group members are not started.
- [ ] #2 A test with an inflight task holding a group and two queued members of it: none of the queued members is started and the next eligible task gets the slot.
- [ ] #3 A test with a live spawned executor for a group member that has not claimed yet: no second member of that group is started.
- [ ] #4 A test: a task with no group is started whatever the group state of other tasks.
- [ ] #5 `peekQueueOrder` returns `sequenceGroup` for a grouped task and omits it for an ungrouped one.
- [ ] #6 No existing claim test changes: `claimNext` still refuses a second holder of a group.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
