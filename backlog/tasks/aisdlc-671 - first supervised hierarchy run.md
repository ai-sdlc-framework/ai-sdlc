---
id: AISDLC-671
title: >-
  RFC-0051 operator task: first supervised run of the session hierarchy, per-role usage, stall log
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0051
  - dispatch
  - operator
dependencies:
  - AISDLC-666
  - AISDLC-667
  - AISDLC-668
  - AISDLC-669
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - docs/operations/parallel-dispatch.md
priority: high
dispatchable: false
dispatchableReason: "Operator-only: needs live sessions, the operator watching, and judgment about what counts as a stall"
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator-run. The first time the hierarchy drives a real brief end to end, with the
operator watching, so that what stalls is recorded rather than worked around.

## Scope
1. Confirm the settings for the bypass tiers include `crossSessionInbound: "accept"`
   and that this repository's governance carries `allowForcePush: leaseOnOwnBranch`
   and the `operational` list.
2. Run `cli-hierarchy up` with two executors first, then five.
3. Generate a brief for a small set of open tasks with `cli-hierarchy brief`, edit it,
   and hand it off.
4. Let the run proceed. For every stall (a held message, a refused action, a parked
   task, a clear that did not resume), record the time, the tier, the cause and the
   workaround used.
5. Confirm that an executor's context was cleared between two consecutive tasks.
6. With the RFC-0050 ledger available, record units per role for the run.
7. Write a results note: tasks completed, stalls by cause, per-role usage, and the
   changes the next run needs.

## Acceptance Criteria
- [ ] Settings and governance are confirmed and recorded before the run.
- [ ] A brief was generated, edited and ingested, and at least five tasks completed through the hierarchy.
- [ ] Every stall is recorded with time, tier, cause and workaround.
- [ ] An executor is shown to have had its context cleared between two tasks.
- [ ] Per-role usage for the run is recorded.
- [ ] A results note exists with the items in step 7.
<!-- SECTION:DESCRIPTION:END -->
