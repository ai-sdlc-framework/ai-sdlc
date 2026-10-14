---
id: AISDLC-823.1
title: 'soak: AC-6 evidence for the scheduled dispatch tick (AISDLC-823)'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [soak, hierarchy, dispatch]
dependencies:
  - AISDLC-823
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: false
dispatchableReason: Soak phase collected over 48 hours of real drain time; human-observed evidence, no code to dispatch.
---

## Context

Parent: AISDLC-823 (dispatch tick is a scheduled PR and board state machine). AISDLC-823 ships with AC-1 to AC-5. Its AC-6 reads:

> AC-6: Soak evidence in the PR body: one drain hour with zero planner messages for mechanical stops.

AC-6 cannot be met inside the implementing PR, so it is collected here once the AISDLC-823 PR (1520) has landed. Planner ruling 2026-10-14 (decision class a).

## Soak procedure

Observe the drain for 48 hours after the AISDLC-823 PR lands, with the scheduled tick running.

Pass criteria:

- No gap longer than 2 hours with queued tasks on the board and no claim made.
- At least one drain hour with zero planner messages for mechanical stops (the AISDLC-823 AC-6 wording).

Evidence to attach (to this task's final summary):

- `cli-dispatch peek` samples taken at least every 2 hours, with timestamps.
- The verdict file mtimes for tasks completed in the window.
- The count of planner messages caused by a mechanical stop (expected zero).

## Acceptance Criteria

- [ ] AC-1: 48 hours of drain observed with the scheduled tick running; no gap longer than 2 hours with queued tasks.
- [ ] AC-2: at least one drain hour with zero planner messages for mechanical stops.
- [ ] AC-3: `cli-dispatch peek` samples and verdict file mtimes attached to the final summary.

## Outcome

On pass, complete this task with the evidence. On failure, file a fix task naming the gap (the classifier row or tick behaviour that left the board idle).
