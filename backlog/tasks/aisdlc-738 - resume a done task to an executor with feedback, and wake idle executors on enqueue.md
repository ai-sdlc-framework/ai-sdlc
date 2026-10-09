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
  - pipeline-cli/src/steps/03-setup-worktree.ts
  - pipeline-cli/src/steps/04-flip-status.ts
  - ai-sdlc-plugin/hooks/lib/trusted-policy.js
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The dispatch board has no done-to-inflight resume path, so a finished task that needs another round cannot be sent back to an executor with instructions. Separately, idle executors back off about 30 minutes, so a new manifest can sit unclaimed for up to half an hour.

Fix direction: a resume command that moves a done verdict back to inflight with a feedback note the executor reads before claiming, plus enqueue wakes an idle executor (or the back-off checks the queue before sleeping).

Fix-round gap (2026-10-09): finished PRs that go red (coverage shortfall, stale attestation after rebase) have no sanctioned path back to an executor. Dispatch cannot lease-push from a finished worktree (hook `not-task-worktree`: a main-rooted session is bound to one task by `AI_SDLC_ACTIVE_TASK_ID` matching the worktree's `.active-task`, which Step 13 removes), and running `/ai-sdlc execute` on a sub-id or on the same id opens a duplicate PR or fails in Step 3 on `branch already exists`. The resume path must therefore re-enter the EXISTING worktree and branch (Steps 3 and 4 in `pipeline-cli/src/steps/03-setup-worktree.ts` and `pipeline-cli/src/steps/04-flip-status.ts`; the binding rule lives in `ai-sdlc-plugin/hooks/lib/trusted-policy.js`).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] A resume command moves a done verdict back to inflight and stores a feedback note.
- [ ] The executor loop reads and surfaces the feedback note before running the task (test).
- [ ] Enqueue wakes an idle executor, or the back-off checks the queue before sleeping, so a new manifest is claimed within a minute (test).
- [ ] Existing requeue and claim behaviour is unchanged for tasks without feedback.
- [ ] `/ai-sdlc execute <id>` on a resumed task reuses the existing worktree and branch when they exist (or recreates the worktree from `origin/<canonical-branch>`, never from `origin/main`), re-writes the `.active-task` sentinel in Step 4, and updates the existing PR instead of opening a new one (test).
- [ ] The feedback note (PR number, failing check names, reviewer findings) is injected into the developer prompt in Step 5 (test).
- [ ] After the fix round the pipeline re-runs reviewers, re-signs the attestation and lease-pushes from that worktree under the same hook rules as a first run.
