---
id: AISDLC-1341
title: 'The blockers list and the eligible queue agree on which dependencies are done'
status: To Do
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - hierarchy
  - adopter
dependencies: []
references:
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.test.ts
priority: medium
dispatchable: true
dispatchableReason: 'Bounded to one function in the dispatch loop and its tests.'
---

## Description

**Gap.** The blockers lines of the dispatch tick and the eligible queue decide differently whether a prerequisite is done. A task can be listed as "waits on X" while the board shows it as eligible, and the reverse.

What was seen in an adopter project on plugin 0.42.0 (reported 2026-11-19): the blockers list said a task "waits on ACS-1" while the board showed the same task as eligible. ACS-1 is complete on main (its task file is under `backlog/completed/`) and the board has no `done/` record for it.

**Cause (read from the source).**

- `pipeline-cli/src/hierarchy/dispatch-loop.ts:398-433` (`computeBlockers`) reads each queued manifest's `after` list and keeps an id as waiting unless `isDone` (`dispatch-loop.ts:686-697`) finds a `done/` completion marker or a success verdict. It never looks at the task file on main, and it counts a success verdict that has not landed as done.
- `pipeline-cli/src/dispatch/board.ts:372-376` (`checkEligibility`) treats an id as done when it has landed (`doneTaskIds`) or its task file is Done on main (`isDoneOnMain`, built at `board.ts:318-323`), and holds a delivered-but-not-landed task with "waiting for X to land".
- The `held:` lines of `status` use the eligibility rule (`pipeline-cli/src/hierarchy/held-triage.ts:119`), so the blockers list is the odd one out.

**Shape.** `computeBlockers` marks a prerequisite as unmet under exactly the rule the eligible queue uses. A task is listed as waiting if and only if the queue holds it back for an unmet `after` entry.

**Control.** No control changes. No task becomes eligible or ineligible; only the report is corrected.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: two copies of the done rule cannot both be right; one rule must serve both. 2. Deleted: the private `isDone` copy used by the blockers list, if nothing else uses it. 3. Simplified or optimised: reuse the board's eligibility context and the same unmet test. 4. Accelerated: the planner no longer chases a blocker that does not exist. 5. Automated: a test builds both views from one board and compares them.

- **Blockers.** Build the eligibility context once per call and list as waiting the `after` ids that the eligibility check calls unmet. Keep the existing line text.
- **Tests.** In `dispatch-loop.test.ts`, add a board where the prerequisite is Done on main with no `done/` record, one where it has a delivered but not landed verdict, and one where it landed; assert the blockers lines against the eligible queue in each.

Out of scope: how sequence groups hold executor starts, the `held:` lines, and any change to what makes a task eligible.

## Acceptance Criteria

- [ ] #1 A test with a prerequisite that is Done on main and has no `done/` record gets no `waits on` line, and the task is in the eligible queue.
- [ ] #2 A test with a prerequisite that has a success verdict that has not landed gets a `waits on` line, and the task is not in the eligible queue.
- [ ] #3 A test with a landed prerequisite gets no `waits on` line.
- [ ] #4 The existing `AISDLC-5: waits on AISDLC-4` test still passes.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
