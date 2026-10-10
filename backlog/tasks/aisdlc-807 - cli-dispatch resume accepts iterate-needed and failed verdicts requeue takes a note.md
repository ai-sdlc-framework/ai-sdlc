---
id: AISDLC-807
title: >-
  cli-dispatch resume accepts iterate-needed and failed verdicts; requeue takes a note
status: To Do
assignee: []
created_date: '2026-10-10'
labels:
  - dispatch
  - velocity
  - root-cause
dependencies: []
references:
  - AISDLC-738
  - AISDLC-800
  - pipeline-cli/src/dispatch/resume.ts
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context.** `cli-dispatch resume` (`pipeline-cli/src/dispatch/resume.ts`, around line 140, from AISDLC-738) accepts only a `done/` verdict whose outcome is `success` (or a completed marker). A task whose executor returned `iterate-needed` (iteration cap hit with an open finding, e.g. AISDLC-676 PR #1360 and AISDLC-725 PR #1346 on 2026-10-10) is exactly the case a resume with a planner note exists for, yet the CLI refuses it. `cli-dispatch requeue` has no `--note` flag, and `release` returns a task that already has a done verdict to the queue as eligible (observed 2026-10-10 23:3xZ with AISDLC-725). Dispatch sessions then either hand-edit manifests or stall; on 2026-10-10 the planner had to authorize hand-written resume notes as an interim.

**Five-step review (requirements first).**
1. Requirement questioned: "resume only from a success verdict" (AISDLC-738 author). It protected against resuming a task that never finished a pipeline run, but an `iterate-needed` verdict is a finished run with feedback, the primary resume case.
2. Delete the outcome restriction: resume accepts any `done/` or `failed/` verdict for the task (success, iterate-needed, failure) and records which it came from. `release` on a task with a done verdict is refused with a next step (`resume` or `remove-verdict`); this is a board invariant to also list under AISDLC-800.
3. Simplify: `requeue --note "<text>"` writes the same `resume.note` shape so there is one note channel.
4. and 5. None.

**Velocity impact.** Positive: removes manual manifest edits and stalls in dispatch.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `resume --task-id X --pr N --note T` succeeds when `done/X.verdict.json` has outcome `iterate-needed`, and when the verdict is in `failed/`; the manifest carries `resume.{prNumber,note,fromVerdictOutcome}`
- [ ] #2 `resume` with no verdict at all still refuses with the existing message
- [ ] #3 `requeue --task-id X --note T` writes `resume.note`
- [ ] #4 `release --task-id X` refuses when `done/X.verdict.json` exists, naming `resume` and `remove-verdict` as next steps
- [ ] #5 Hermetic tests in `pipeline-cli/src/dispatch` cover AC1 to AC4
- [ ] #6 `docs/operations` (the dispatch board doc or operator-dispatch.md) describes the three verdict outcomes resume accepts
<!-- AC:END -->

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test`
- `pnpm lint && pnpm format:check`
