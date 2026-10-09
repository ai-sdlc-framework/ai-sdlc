---
id: AISDLC-738
title: >-
  resume a done task to an executor with feedback, and wake idle executors on enqueue
status: Done
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
  - pipeline-cli/src/steps/03-setup-worktree.ts
  - pipeline-cli/src/steps/04-flip-status.ts
  - ai-sdlc-plugin/hooks/lib/trusted-policy.js
priority: critical
dispatchable: true
updated_date: '2026-10-09 18:19'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The dispatch board has no done-to-inflight resume path, so a finished task that needs another round cannot be sent back to an executor with instructions. Separately, idle executors back off about 30 minutes, so a new manifest can sit unclaimed for up to half an hour.

Fix direction: a resume command that moves a done verdict back to inflight with a feedback note the executor reads before claiming, plus enqueue wakes an idle executor (or the back-off checks the queue before sleeping).

Fix-round gap (2026-10-09): finished PRs that go red (coverage shortfall, stale attestation after rebase) have no sanctioned path back to an executor. Dispatch cannot lease-push from a finished worktree (hook `not-task-worktree`: a main-rooted session is bound to one task by `AI_SDLC_ACTIVE_TASK_ID` matching the worktree's `.active-task`, which Step 13 removes), and running `/ai-sdlc execute` on a sub-id or on the same id opens a duplicate PR or fails in Step 3 on `branch already exists`. The resume path must therefore re-enter the EXISTING worktree and branch (Steps 3 and 4 in `pipeline-cli/src/steps/03-setup-worktree.ts` and `pipeline-cli/src/steps/04-flip-status.ts`; the binding rule lives in `ai-sdlc-plugin/hooks/lib/trusted-policy.js`).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] A resume command moves a done verdict back to inflight and stores a feedback note.
- [x] The executor loop reads and surfaces the feedback note before running the task (test).
- [x] Enqueue wakes an idle executor, or the back-off checks the queue before sleeping, so a new manifest is claimed within a minute (test).
- [x] Existing requeue and claim behaviour is unchanged for tasks without feedback.
- [x] `/ai-sdlc execute <id>` on a resumed task reuses the existing worktree and branch when they exist (or recreates the worktree from `origin/<canonical-branch>`, never from `origin/main`), re-writes the `.active-task` sentinel in Step 4, and updates the existing PR instead of opening a new one (test).
- [x] The feedback note (PR number, failing check names, reviewer findings) is injected into the developer prompt in Step 5 (test).
- [x] After the fix round the pipeline re-runs reviewers, re-signs the attestation and lease-pushes from that worktree under the same hook rules as a first run.

## Final Summary

## Summary
Added a resume path for finished tasks and a bounded idle back-off. `cli-dispatch resume` puts a done task back on the queue with a feedback note on its manifest; the next claim (executor-start) prints the note; `/ai-sdlc execute` re-enters the task's existing worktree and branch (never from origin/main), re-writes the `.active-task` sentinel, injects the note into the developer prompt, re-runs reviewers and updates the existing PR with a policy-gated lease push. `cli-dispatch idle-backoff` caps the empty-queue wake-up at 60 seconds.

## Changes
- `pipeline-cli/src/dispatch/resume.ts` (new): resume operation, feedback formatting, resume authorisation.
- `pipeline-cli/src/dispatch/idle-backoff.ts` (new): bounded idle sleep.
- `pipeline-cli/src/cli/dispatch.ts`, `dispatch/complete.ts`, `dispatch/types.ts`, `dispatch/index.ts`: `resume` and `idle-backoff` subcommands, done-manifest snapshot, `ResumeFeedback` type.
- `pipeline-cli/src/hierarchy/executor-start.ts`: prints a RESUMED TASK block at claim.
- `pipeline-cli/src/execute-pipeline.ts`, `steps/01,03,04,05,10,11`: resume re-entry, sentinel rewrite, fenced note in the developer prompt, lease push after policy / protected-branch / own-worktree checks pinned to the recorded remote SHA, existing PR updated.
- `ai-sdlc-plugin/commands/{executor,operator-dispatch,execute}.md`, `spec/schemas/dispatch-manifest.v1.schema.json`, `reference/src/core/generated-schemas.ts`.

## Design decisions
- **Resume lands in queue/, not straight in inflight/**: the normal claim then moves it to inflight, keeping claim ownership and the workerId check unchanged.
- **Reuses the `requeue` operational grant and the dispatch-caller check**: no governance config touched.
- **resumedBy is the verified caller roster name**: resume mode is authorised only for a roster operator-dispatch issuer; a mistake guard, not authentication.
- **Idle wake-up**: main's `clear --self --resume-after 30` path already restarts an idle executor; the no-tmux fallback now sleeps `idle-backoff` seconds (<=60) instead of 1800.

## Verification
- `pnpm build` clean; `pnpm lint` (eslint + clock-discipline) clean; `pnpm format:check` clean
- pipeline-cli vitest: all pass except `bin-invocation.test.ts` (4 failures identical on origin/main)
- plugin command tests: same 4 pre-existing failures as origin/main

## Follow-up
(none)
