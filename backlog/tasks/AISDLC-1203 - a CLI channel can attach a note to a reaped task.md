---
id: AISDLC-1203
title: 'A CLI channel can attach a note to a reaped task'
status: To Do
assignee: []
created_date: '2026-11-06'
labels:
  - hierarchy dispatch defect triage
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reenter.ts
  - pipeline-cli/src/cli/dispatch.ts
priority: low
dispatchable: false
---

## Description

**Source.** Planner session 2026-11-06; filed on operator go (decision rubric, same day). Non-dispatchable until triaged.

After the reaper kills an executor, the planner had no CLI path to attach a diagnosis note (for example "raise the next-step timeout") to the task before it is re-entered. The note had to travel as prose to dispatch.

**Affected surface.** `pipeline-cli/src/cli/dispatch.ts` (new subcommand) and `pipeline-cli/src/hierarchy/reenter.ts` (surfaces the note on re-entry).

## Acceptance Criteria
- [ ] #1 A CLI subcommand attaches a note to a failed or reaped task; the next re-entry surfaces it to the executor.
- [ ] #2 A test covers note attach and surfacing.
