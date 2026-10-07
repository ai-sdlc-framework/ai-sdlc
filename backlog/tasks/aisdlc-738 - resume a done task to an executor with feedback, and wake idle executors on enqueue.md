---
id: AISDLC-738
title: >-
  resume a done task to an executor with feedback, and wake idle executors on enqueue
status: To Do
assignee: []
created_date: '2026-10-06'
labels:
  - orchestrator
dependencies: []
references:
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/dispatch/enqueue.ts
  - pipeline-cli/src/dispatch/requeue.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - ai-sdlc-plugin/commands/executor.md
  - ai-sdlc-plugin/commands/operator-dispatch.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The dispatch board has no done-to-inflight resume path, so a finished task that needs another round cannot be sent back to an executor with instructions. Separately, idle executors back off about 30 minutes, so a new manifest can sit unclaimed for up to half an hour.

Fix direction: a resume command that moves a done verdict back to inflight with a feedback note the executor reads before claiming, plus enqueue wakes an idle executor (or the back-off checks the queue before sleeping).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] A resume command moves a done verdict back to inflight and stores a feedback note.
- [ ] The executor loop reads and surfaces the feedback note before running the task (test).
- [ ] Enqueue wakes an idle executor, or the back-off checks the queue before sleeping, so a new manifest is claimed within a minute (test).
- [ ] Existing requeue and claim behaviour is unchanged for tasks without feedback.
