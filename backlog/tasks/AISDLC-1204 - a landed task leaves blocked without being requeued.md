---
id: AISDLC-1204
title: 'A landed task leaves blocked without being requeued'
status: To Do
assignee: []
created_date: '2026-11-06'
labels:
  - dispatch defect triage
dependencies: []
references:
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/cli/dispatch.ts
priority: low
dispatchable: false
---

## Description

**Source.** Planner session 2026-11-06; filed on operator go (decision rubric, same day). Non-dispatchable until triaged.

AISDLC-1191 landed at 2cd45a9f (#2411), but its board record stays in `blocked/` with reason "awaiting gate re-run". The only exit, `cli-dispatch unblock`, moves the task back to the queue, which would re-dispatch landed work. `cli-hierarchy status` keeps listing it as blocked.

## Acceptance Criteria
- [ ] #1 The landing reconciler (or a `cli-dispatch` subcommand) moves a blocked task whose PR merged to done, recording the merge sha.
- [ ] #2 A test covers a blocked task whose PR merged.
