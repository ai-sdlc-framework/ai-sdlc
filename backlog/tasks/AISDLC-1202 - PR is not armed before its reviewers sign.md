---
id: AISDLC-1202
title: 'PR is not armed before its reviewers sign'
status: In Progress
assignee: []
created_date: '2026-11-06'
updated_date: '2026-11-07 00:00'
labels:
  - pipeline-cli hierarchy defect triage
dependencies: []
references:
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/hierarchy/pr-state.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
priority: medium
dispatchable: true
dispatchableReason: 'Triaged and unparked 2026-11-07 by operator ruling (decision rubric, planner session).'
---

## Description

**Source.** Planner session 2026-11-06; filed on operator go (decision rubric, same day). Triaged and made dispatchable 2026-11-07.

**Premise correction (2026-11-07).** The filing said the PR is opened and armed at 06-dev-done. On main, `pipeline-cli/src/next-step/ship.ts` already opens a draft PR at Step 11 and marks it ready at close (Step 13, after the verdict record is attached), so the first round is covered. The window is later developer rounds on a PR that is already ready: the dispatch reconciler sees failing checks on a live round and counts them as failures (seen on #2411, #2413, #2415), pushing tasks toward the two-failure limit for work still in progress.

**Affected surface.** `pipeline-cli/src/hierarchy/pr-state.ts` (failure classification) and `pipeline-cli/src/hierarchy/reconcile.ts` (failure counting and the park decision). `ship.ts` is referenced for the premise, not changed.

## Ruling 2026-11-07 (operator, decision rubric)

Option A. Merge queues and gate pipelines (GitHub merge queue, Zuul, Bors) only account failures for the submitting state, not while iterating. Counter-argument: skipping the count hides a badly-going round; rebutted because the executor's verdict and the pane still show red, and the thing removed is the automatic park while someone is working. Chosen over flipping to draft on reenter (touches mark-ready and GitHub review state) and over raising the limit (does not fix the accounting).

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: "a failing check on a PR counts toward the task's failure limit" (reconciler, AISDLC-823 line); it was meant for a PR nobody is working on. 2. Deleted: the automatic park of a task whose round is still running; nothing else is removed. 3. Simplified: one condition in the counting path (inflight with a live claim means do not count), no new PR state and no draft flip. 4. Accelerated: a round in progress is no longer interrupted by a park and re-entry. 5. Automated: covered by two unit tests on the counter.

The reconciler does not increment a task's failure count for a PR whose task is inflight with a live claim. Counting resumes when the round ends, that is when the claim is released or the verdict is written. The CI gate itself still runs on every push (no draft flip, no change to `mark-ready.ts`); only the accounting changes. The reconciler log line for a skipped count says why (`inflight, claim held by <executor>`), so the pane and the log still show the red check.

## Acceptance Criteria
- [ ] #1 Unit test: a failing check on the PR of a task that is inflight with a live claim leaves the task's failure count unchanged.
- [ ] #2 Unit test: the same failing check observed after the claim is released (or the verdict is written) increments the failure count.
- [ ] #3 The CI gate still runs on the PR (no draft flip; `mark-ready.ts` and the Step 11/13 flow in `ship.ts` are unchanged), and the skipped count is logged with its reason.
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
