---
id: AISDLC-950
title: 'cli-file removes its untracked source copy from the parent after pushing the filing branch, so Step 0.5 does not try to re-file it under an existing branch'
status: Done
assignee: []
created_date: '2026-10-16'
labels:
  - pipeline
  - filing
  - bug
dependencies: []
references:
  - pipeline-cli/src/cli/file.ts
  - pipeline-cli/src/cli/file.test.ts
  - pipeline-cli/src/steps/00-5-sync-parent.ts
  - docs/operations/backlog-and-execution-reference.md
priority: high
dispatchable: true
---

## Description

`cli-file task <path> --pr` copies the task file onto branch `ai-sdlc/file-<id>`, pushes it and opens the PR, but leaves the original file untracked in the parent working tree. Step 0.5 (`00-5-sync-parent.ts`) treats any untracked `backlog/tasks/` file in the parent as something to file and runs `git worktree add -b ai-sdlc/file-<id>`, which fails because that branch already exists. On 2026-10-16 this aborted the start of AISDLC-815 on executor epsilon (decision DEC-0257) and would have aborted every later task start on the parent until the planner deleted the copy by hand. The copy was byte-identical to the branch, so nothing was lost by deleting it.

**Five-step review (requirements first).**
1. Requirement questioned: does the parent need the source copy after filing? No; the branch and the PR hold it, and the parent is read-only in Pattern C.
2. Delete: the leftover copy. After the push succeeds, `cli-file` removes the source file when it is untracked and identical to the branch copy.
3. Simplify: one check, "untracked and identical", then `rm`; a file that differs or is tracked is left alone with a printed line.
4. Accelerate: Step 0.5 skips an untracked file whose filing branch already exists instead of aborting, and prints which branch holds it.
5. Automate: a `file.test.ts` case that files a task and asserts the source is gone, plus a Step 0.5 test for the existing-branch case.

Velocity impact: positive; a filing no longer blocks the next executor start.

## Acceptance Criteria

- [ ] AC-1: After a successful push, `cli-file task` and `cli-file decision` remove the untracked source file when it is byte-identical to the committed copy; otherwise they print that it was kept and why.
- [ ] AC-2: Step 0.5 does not abort when an untracked `backlog/tasks/` file already has a filing branch; it skips the file and names the branch.
- [ ] AC-3: Tests cover AC-1 (removed, kept because tracked, kept because different) and AC-2.
- [ ] AC-4: `docs/operations/backlog-and-execution-reference.md` describes the post-push cleanup.

## Notes

Origin: DEC-0257, 2026-10-16 19:34Z (AISDLC-815 start aborted at Step 0.5 on the AISDLC-948 filing copy).
