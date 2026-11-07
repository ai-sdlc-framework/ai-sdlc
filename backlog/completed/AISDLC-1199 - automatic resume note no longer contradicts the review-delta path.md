---
id: AISDLC-1199
title: 'Automatic resume note no longer contradicts the review-delta path'
status: Superseded
assignee: []
created_date: '2026-11-06'
updated_date: '2026-11-07 06:00'
labels:
  - hierarchy defect triage
dependencies: []
references:
  - pipeline-cli/src/hierarchy/stall.ts
  - pipeline-cli/src/hierarchy/reenter.ts
  - pipeline-cli/src/hierarchy/executor-start.ts
priority: medium
dispatchable: true
dispatchableReason: 'Unparked 2026-11-07 by operator ruling (planner critical-path review).'
---

## Description

**Source.** Planner session 2026-11-05/06; filed on operator go (decision rubric, 2026-11-06). Triaged; Unparked 2026-11-07 by operator ruling (planner critical-path review).

A re-entered task carries an automatic resume note built by `stallResumeNote` in `pipeline-cli/src/hierarchy/stall.ts` (around line 168: "Pull request #N already exists; continue from it and do not re-run the developer."), not in `reenter.ts`; `executor-start.ts` surfaces it. The note tells the executor "do not re-run the developer", while the review-delta resume path can require a developer round. The executor gets contradictory instructions.

## Acceptance Criteria
- [ ] #1 The resume note is derived from the resume path it accompanies; a path that may run the developer never carries "do not re-run the developer".
- [ ] #2 A test covers the note for each resume path.

## Resolution

Superseded 2026-11-07 (planner, class (a) under DEC-0392). AISDLC-1219 (#2489, `a6bbc55d`) removed `stallResumeNote`, `StallDeps.requeue` and the stall requeue path from `pipeline-cli/src/hierarchy/stall.ts`: a reaped task is no longer re-entered with an automatic resume note, it gets a `failed/<task>.diagnostic.json` and its holder is cleared. The contradictory note this task fixed no longer exists on `main`; no other automatic resume note carries "do not re-run the developer" (`reenter.ts` and `executor-start.ts` build none). PR #2490 (head `a340aeec`) could not be rebased: its only hunks re-add code with no caller (DEC-0394 rebase attempt, rebase-resolver, 2026-11-07 05:5xZ). The PR is left for the operator to close.
