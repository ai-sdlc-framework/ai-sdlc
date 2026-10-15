---
id: AISDLC-921
title: 'feat: cli-file task --update edits an existing task on main through the filing path'
status: To Do
assignee: []
created_date: '2026-10-15'
labels: [enhancement, cli-file, backlog, pipeline-cli, velocity]
dependencies: []
references: [pipeline-cli/src/cli/file.ts, pipeline-cli/src/cli/file.test.ts, pipeline-cli/bin/cli-file.mjs]
priority: high
dispatchable: true
---

## Description

The consumer project ai-sdlc-io (plugin 0.29.0) had a task sitting at `dispatchable: false` with the reason "planner flips this to true when <upstream> merges". When the upstream merged, the flip was a one-line frontmatter edit, but `cli-file task` refuses an id that already exists on `origin/main` (`file.ts` around line 282: "task id ... already exists on origin/main ... (case-insensitive match)"), so the planner had to make a branch and a PR by hand, outside the sanctioned filing path and its ASCII, drift and DoR checks.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that an existing task must never pass through the filing path. It is a guard against double-filing, not against editing; an explicit flag keeps the guard. 2. Deleted: the hand-made branch and PR; nothing else to delete. 3. Simplified: one new flag on the existing `task` subcommand, reusing the same checks and the same branch, fast-forward push and PR steps. 4. Accelerated: a state flip lands in one command instead of a manual branch-and-PR cycle. 5. Automated: tests in `file.test.ts` cover both the accepted and the refused path, so the guard cannot regress.

`cli-file task --update <path>` accepts a task whose id exists on `origin/main` when the file at `<path>` has that same id. It runs the same ASCII, drift and DoR checks, branches from `origin/main`, pushes fast-forward and opens the PR. Without `--update` an existing id is refused exactly as today. With `--update`, a path whose id does not exist on main is refused (use the plain form).

## Acceptance Criteria

- [ ] `--update` with an existing id passes the duplicate-id check and runs the ASCII, drift and DoR checks unchanged.
- [ ] The branch is created from `origin/main`, pushed fast-forward, and a PR is opened.
- [ ] Without `--update`, an existing id is refused with the current message.
- [ ] With `--update`, an id that does not exist on main is refused.
- [ ] Tests in `file.test.ts` cover the four cases above.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Source: friction report from ai-sdlc-io on plugin 0.29.0. Alternative considered: making `dispatchable` a brief-level concern (the brief, not the task file, would carry the hold), which would avoid editing the task at all. Rejected for now because it adds a second place that decides dispatch eligibility; `--update` fixes the whole class of task edits, not only this flag.
