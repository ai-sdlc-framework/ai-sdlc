---
id: AISDLC-681.1
title: >-
  Stop-hook deferred coverage check ignores index-only drift and never runs workspace coverage from a hierarchy main checkout
status: Done
assignee: []
created_date: '2026-10-02'
labels:
  - hooks
  - plugin
  - operations
  - session-hierarchy
dependencies:
  - AISDLC-681
references:
  - ai-sdlc-plugin/plugin.json
  - docs/operations/parallel-dispatch.md
priority: high
dispatchable: true
---

## Resolution

Superseded by AISDLC-726 per DEC-0056 (planner, 2026-10-06).

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator-filed 2026-10-02, the primary cause of the day's two near out-of-memory
events. `deferred-coverage-check.js` runs on the `Stop` hook and executes the whole
workspace `pnpm test:coverage` in `CLAUDE_PROJECT_DIR` whenever `git status` lists a
dirty `.ts`/`.js` file. In the session hierarchy every session's project dir is the
main checkout, whose index drifts after each pipeline fast-forward of `main` (214
index-only entries today). Result: six sessions each ran full coverage in the same
checkout at the end of every turn, hook timeouts orphaned the vitest workers, and the
machine ran out of memory twice. A session started from the non-git parent directory
never hit this, which hid it until today.

## Conventions
- Plugin hooks under `node --test`, hermetic fixtures (temporary git repos), no reads of
  the real home directory.
- Behaviour for an adopter's single-session setup stays as today.

## Scope
1. **Index-only drift is not a change:** the dirty-file detection compares the working
   tree to HEAD (`git diff HEAD --name-only` plus untracked), not the index; staged
   renames or deletions with an unchanged working tree do not trigger a run.
2. **Hierarchy main checkout opt-out:** when the project dir is the main checkout of a
   repository that has a `.worktrees/` directory with at least one task worktree, or
   when the session is a roster role (`AI_SDLC_HIERARCHY_ROLE` set or the roster names
   the session), the hook exits 0 without running coverage; the coverage obligation
   belongs to the executor's worktree and the pre-push gate.
3. **Repository-wide lock and ceiling:** reuse AISDLC-681's lock and `--maxWorkers`
   ceiling so two sessions can never run the suite concurrently, and the hook's own
   timeout kills the whole process group.
4. **Docs:** the parallel-dispatch runbook states that the Stop-hook coverage check is
   inert for hierarchy sessions and why.

## Acceptance Criteria
- [ ] A fixture repo with staged deletions and an unchanged working tree produces no coverage run; the same repo with one modified `.ts` file does.
- [ ] From a main checkout that has a task worktree under `.worktrees/`, the hook exits 0 without spawning anything.
- [ ] With `AI_SDLC_HIERARCHY_ROLE=executor` the hook exits 0 without spawning anything.
- [ ] Two hook invocations started concurrently against the same repo serialise on the lock; a killed invocation leaves no vitest process after 5 seconds.
- [ ] Runbook paragraph present; `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
