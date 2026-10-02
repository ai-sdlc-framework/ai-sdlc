---
id: AISDLC-681.2
title: >-
  Pipeline sync of the parent checkout's main updates the index and working tree, never only the ref
status: To Do
assignee: []
created_date: '2026-10-02'
labels:
  - orchestrator
  - operations
  - worktrees
dependencies:
  - AISDLC-681
references:
  - orchestrator/src/execute.ts
  - pipeline-cli/src/steps/13-cleanup.ts
  - docs/operations/parallel-dispatch.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator-filed 2026-10-02. After each merge the pipeline moves the parent checkout's
`main` to `origin/main`, but it moves only the ref, leaving the index and working tree
at the previous commit. `git status` in the parent then lists every file the merge
touched as staged changes (214 entries today), which every Stop-hook coverage check
reads as dirty source and which the operator has stashed by hand four times in two
days ("parent-debris" stashes). The parent checkout is a read-only contract, so a sync
that leaves it inconsistent is a bug.

## Conventions
- TypeScript strict, ESM, Vitest, hermetic tests on temporary repositories.
- The parent is never reset while it has unstaged or untracked changes of its own;
  in that case the sync logs and leaves it alone.

## Scope
1. Locate the step that advances the parent's `main` in `orchestrator/src/execute.ts` (cleanup after merge and any
   worktree-setup fast-forward) and make it a proper fast-forward of the checked-out
   branch: `git -C <parent> merge --ff-only origin/main` when `main` is checked out and
   the tree is clean, otherwise `git update-ref` only when `main` is not checked out.
2. If the parent has local unstaged or untracked changes, do not touch it; emit one
   warning naming the parent path.
3. `doctor` reports a parent checkout whose index differs from HEAD with the exact
   `git stash push -m` command to recover.

## Acceptance Criteria
- [ ] After a simulated merge and sync on a fixture parent with `main` checked out and a clean tree, `git status --porcelain` in the parent is empty and HEAD equals `origin/main`.
- [ ] With an unstaged local change in the parent, the sync leaves HEAD and the change untouched and logs a warning.
- [ ] With a different branch checked out in the parent, only the `main` ref moves.
- [ ] `doctor` flags index-vs-HEAD drift in the parent and is quiet when clean.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
