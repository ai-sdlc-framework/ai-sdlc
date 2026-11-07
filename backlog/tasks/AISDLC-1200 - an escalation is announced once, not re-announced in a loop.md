---
id: AISDLC-1200
title: 'An escalation is announced once, not re-announced in a loop'
status: In Progress
assignee: []
created_date: '2026-11-06'
labels:
  - hierarchy defect triage
dependencies: []
references:
  - pipeline-cli/src/hierarchy/escalation-file.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
priority: medium
dispatchable: true
dispatchableReason: 'Unparked 2026-11-07 by operator ruling (planner critical-path review).'
---

## Description

**Source.** Planner session 2026-11-05; filed on operator go (decision rubric, 2026-11-06). Triaged; Unparked 2026-11-07 by operator ruling (planner critical-path review).

Between 2026-11-04 22:19 and 2026-11-05 09:57 local, 1230 escalation files were written for AISDLC-1190: the same escalation was re-announced on every tick. The loop has stopped, but nothing prevents it recurring.

**Scope narrowed 2026-11-07.** The planner-notification half is done: #2414 (AISDLC-1190) dedupes the planner line per task and message for an hour. What remains is the file writer: `writeEscalationFile` in `pipeline-cli/src/hierarchy/escalation-file.ts` (around line 55) writes a new file under `<boardDir>/escalations/` on every call with no check for an existing file for the same task, message and head; `.ai-sdlc/dispatch/escalations/` held 4798 files on 2026-11-07.

## Acceptance Criteria
- [ ] #1 `writeEscalationFile` is idempotent for the same task, message and head: when a matching escalation file already exists it returns that file's path and writes nothing new.
- [ ] #2 A test calls `writeEscalationFile` repeatedly (and runs repeated ticks through `dispatch-loop.ts`) against one escalation and asserts exactly one file in `escalations/`.
- [ ] #3 A different message or head for the same task still produces a new file (test).
