---
id: AISDLC-762.1
title: >-
  next-step init re-enters an existing worktree or branch: resume and zero-commit reuse are passed to Step 3
status: To Do
assignee: []
created_date: '2026-10-11'
labels:
  - next-step
  - dispatch
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/next-step/init.ts
  - pipeline-cli/src/cli/next-step.ts
  - pipeline-cli/src/steps/03-setup-worktree.ts
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context.** Since AISDLC-762 landed (PR #1303), `/ai-sdlc execute` runs the next-step state machine. Its init (`initTask` in `pipeline-cli/src/next-step/init.ts`) calls `setupWorktree({ taskId, branch, worktreePath, workDir, runner })` and never sets Step 3's `resume` option (`SetupWorktreeOptions.resume`, AISDLC-738, handled by `resumeWorktree` in `pipeline-cli/src/steps/03-setup-worktree.ts`). Every resume therefore stops at Step 3 with "a branch named ai-sdlc/aisdlc-<id>-... already exists" (the `branch already exists` refusal near line 433). Observed three times:

- AISDLC-676 (PR #1360), decision DEC-0111.
- AISDLC-797 (PR #1388), decision DEC-0112.
- AISDLC-801, decision DEC-0113: a zero-commit leftover branch from a Step 3 that failed under the wrong Node (see AISDLC-812).

Executors fell back to hand rebases. Fix rounds that need reviewers and signing (AISDLC-676, 800, 804, 805) are parked behind this.

**Five-step review (requirements first).**
1. Requirement questioned: "Step 3 refuses an existing branch". It protects fresh work from a name collision. For a resume, the existing worktree or branch IS the work, so the refusal is wrong there.
2. Delete: remove the refusal for the resume case instead of adding cleanup commands for the operator or executor to run.
3. Simplify: one rule in `initTask` (and the `pipeline-cli/src/cli/next-step.ts` entry that calls it). When the task's worktree or branch already exists, or the dispatch manifest carries a `resume` block, or its verdict is `iterate-needed` or `failed`, set `resume: true` and re-enter. Step 4 rewrites the sentinel and Step 10 signs after the final rebase. A branch with zero commits ahead of main is reused as a fresh start.
4. Accelerate / 5. Automate: executors and dispatch sessions no longer hand-rebase; the same init path serves fresh and resumed tasks.

**Velocity impact.** Positive: unparks the review-and-sign fix rounds and removes hand rebases.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Hermetic next-step test: an existing worktree plus branch with commits makes init enter resume mode and Step 3 reuses them (no "already exists" refusal)
- [ ] #2 A zero-commit branch at main is reused, no refusal
- [ ] #3 A fresh task with no branch or worktree follows the unchanged path (`resume` not set)
- [ ] #4 A manifest produced by `cli-dispatch resume` (resume block, or iterate-needed / failed verdict) drives the same resume mode
- [ ] #5 DEC-0111, DEC-0112 and DEC-0113 are cited in the task body
- [ ] #6 The five steps are named in the task body
- [ ] #7 `pnpm build && pnpm --filter @ai-sdlc/pipeline-cli test`, `pnpm lint` and `pnpm format:check` pass
<!-- AC:END -->
