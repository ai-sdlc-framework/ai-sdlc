---
id: AISDLC-923
title: 'fix: cli-hierarchy brief --notify keeps the existing brief path and the full dependency list'
status: Done
assignee: []
created_date: '2026-10-15'
labels: [bug, hierarchy, brief, pipeline-cli, velocity]
dependencies: []
references: [pipeline-cli/src/hierarchy/brief.ts, pipeline-cli/src/hierarchy/brief.test.ts, pipeline-cli/src/hierarchy/brief-notify.ts]
priority: medium
dispatchable: true
---

## Description

Two defects seen in ai-sdlc-io on plugin 0.29.0. First, `cli-hierarchy brief --tasks ... --notify` re-slugs the brief when a listed task is already done: the slug is derived from the remaining tasks (`selectTasks`, `brief.ts` around line 407), so a brief written as `tasks-io-1-plus-4.md` became `tasks-io-2-plus-3.md`, and dispatch was notified about the fresh, wrong file. Second, the regenerated YAML narrowed a task's cross-brief `after:` to a single dependency, dropping the task file's other dependencies. `--out` is the current workaround.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that the slug should depend on which tasks are still open. A brief's identity is the list the planner named. 2. Deleted: the slug's dependence on completion state. 3. Simplified: derive the slug once from the full task list (done tasks included), and when the file exists, `--notify` notifies about that exact path. 4. Accelerated: no `--out` workaround. 5. Automated: tests for both defects.

A regenerated entry's `after` is the union of the task file's `dependencies` and is never narrower than it.

## Acceptance Criteria

- [ ] The slug is computed from the full `--tasks` list, done tasks included.
- [ ] `--notify` with an existing brief file notifies about that exact path and does not write a new file.
- [ ] A regenerated entry's `after` equals the union of the task file's `dependencies`.
- [ ] Tests in `brief.test.ts` cover both defects.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Source: friction report from ai-sdlc-io on plugin 0.29.0.
