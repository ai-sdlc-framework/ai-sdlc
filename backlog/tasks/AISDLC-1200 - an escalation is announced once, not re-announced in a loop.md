---
id: AISDLC-1200
title: 'An escalation is announced once, not re-announced in a loop'
status: To Do
assignee: []
created_date: '2026-11-06'
labels:
  - hierarchy defect triage
dependencies: []
references:
  - pipeline-cli/src/hierarchy/escalation-file.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
priority: medium
dispatchable: false
---

## Description

**Source.** Planner session 2026-11-05; filed on operator go (decision rubric, 2026-11-06). Non-dispatchable until triaged.

Between 2026-11-04 22:19 and 2026-11-05 09:57 local, 1230 escalation files were written for AISDLC-1190: the same escalation was re-announced on every tick. The loop has stopped, but nothing prevents it recurring.

## Acceptance Criteria
- [ ] #1 An escalation with the same task, reason and head is written once; later ticks see it and do not write another.
- [ ] #2 A test runs repeated ticks against one escalation and asserts a single file.
