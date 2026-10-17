---
id: AISDLC-958
title: 'Step 0 sweep queries GitHub once per execute and caches landed results, instead of one gh pr list per worktree'
status: Done
assignee: []
created_date: '2026-10-16'
labels:
  - pipeline
  - cost
dependencies: []
references:
  - pipeline-cli/src/steps/00-sweep.ts
  - pipeline-cli/src/next-step/init.ts
  - docs/operations/backlog-and-execution-reference.md
priority: high
dispatchable: true
---

## Description

Step 0 (`pipeline-cli/src/steps/00-sweep.ts`, called from `pipeline-cli/src/next-step/init.ts`) of every `/ai-sdlc execute` (and every resume, re-entry and fix round) runs `gh pr list --head <branch> --state all` once for EVERY directory under `.worktrees/`. With 80 worktrees on the machine and five executors that is about 600 user-token calls per hour, two thirds of everything the operator machine spends, before any task work starts. A landed PR never changes state, so most of those calls return the same answer every time.

**Five-step review (requirements first).**
1. Requirement questioned: does the sweep need a fresh answer per worktree per run? No; it needs to know which worktree branches have a landed or closed PR, and that fact is permanent once true.
2. Delete: the per-worktree query loop.
3. Simplify: one `gh pr list --state all --limit 200 --json number,state,headRefName,mergedAt` per sweep, matched against the worktree branch names locally; a small on-disk cache under `.ai-sdlc/` records branches already known landed or closed so they are never queried again.
4. Accelerate: a sweep with only cached-landed worktrees makes zero calls.
5. Automate: a unit test with 80 fake worktrees asserts at most one list call; a second run with the cache asserts zero.

## Acceptance Criteria

- [x] Step 0 makes at most one GitHub call per execute regardless of the number of worktrees, and zero when every worktree is cached as landed or closed.
- [x] Removed worktrees drop out of the cache; a worktree whose branch gets a new PR is re-queried.
- [x] The execution reference documents the cache file and how to clear it.
