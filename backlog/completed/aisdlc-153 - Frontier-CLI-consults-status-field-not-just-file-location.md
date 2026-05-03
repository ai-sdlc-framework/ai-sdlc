---
id: AISDLC-153
title: Frontier CLI consults status field, not just file location
status: Done
assignee: []
created_date: '2026-05-02 19:20'
labels:
  - deps
  - cli
  - bug
dependencies: []
references:
  - backlog/completed/aisdlc-117 - Compute-backlog-task-dependency-graph-integrate-into-dispatch-frontier.md
  - pipeline-cli/src/deps/dependency-graph.ts
  - pipeline-cli/src/cli/deps.ts
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Bug

`pnpm --filter @ai-sdlc/pipeline-cli exec cli-deps frontier --format table` (the dispatch-ready frontier CLI from AISDLC-117) was showing already-completed tasks as ready to dispatch.

Concrete example: frontier output listed AISDLC-115.7, AISDLC-129, AISDLC-130, AISDLC-131, AISDLC-139, AISDLC-140, AISDLC-141, AISDLC-143, AISDLC-144 — all merged with PRs closed. They appeared ready because their files were still in `backlog/tasks/` (not every PR's squash includes the file move).

This poisoned the dispatch picture: operators (and the orchestrator) couldn't trust frontier output. Already-merged tasks got re-considered for dispatch; the genuinely-ready tasks got buried in noise.

## Root cause

The frontier filter looked exclusively at file location (`backlog/tasks/` = open) and ignored the `status:` frontmatter field. A task with `status: Done` still in `backlog/tasks/` was treated as open. That assumption breaks any time a `chore: mark X complete` commit lands in main without the matching `git mv` (which happens routinely on squash-merged PRs that don't include the file move).

## Fix (this task)

`buildDependencyGraph` now consults BOTH the file location AND the frontmatter `status:` field. A task is treated as **completed** for dispatch purposes if EITHER:

- File lives in `backlog/completed/`, OR
- File lives in `backlog/tasks/` but `status:` is `Done` / `Completed` / `Shipped` (case-insensitive)

The second case is a "stale entry" — the task is shipped but the file hasn't been moved. We surface a one-line warning on stderr so the operator can `git mv` + commit, but we never block dispatch on it. The warning includes the exact `git mv` command to run.

`DependencyNode` now carries both `status` (effective dispatch status) and `fileLocation` (raw on-disk position) plus `frontmatterStatus` (raw `status:` value), so callers can still reason about the on-disk picture if they need to.

The CLI subcommands (`frontier`, `blockers`, `impact`, `validate`, `graph`, `preflight`) all forward warnings to stderr via a shared `warnToStderr` helper, keeping stdout JSON-clean for machine consumers.

## Workaround for stale entries (humans)

When you see a stale-task warning, the fix is mechanical:

```bash
git mv backlog/tasks/aisdlc-NNN\ -\ ....md backlog/completed/
git commit -m 'chore: move stale completed task AISDLC-NNN to backlog/completed/ (AISDLC-NNN)'
```

Bulk cleanup of all currently-stale entries ships separately as AISDLC-150.

## Files touched

- `pipeline-cli/src/deps/dependency-graph.ts` — add `fileLocation` + `frontmatterStatus` to `DependencyNode`; reclassify stale entries in `buildDependencyGraph`; warning emission via `onWarn`
- `pipeline-cli/src/cli/deps.ts` — wire `warnToStderr` into every `buildDependencyGraph` call site
- `pipeline-cli/src/deps/dependency-graph.test.ts` — 4 new scenarios + edge cases (synonyms, blockers/preflight reclassification, completed-wins-on-collision)
- `pipeline-cli/src/cli/deps.test.ts` — CLI-level smoke that stderr warning surfaces for stale-Done tasks
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Frontier CLI consults BOTH file location AND `status:` field; stale entries (file in tasks/, status: Done) reclassified as completed
- [x] #2 One-line stderr warning surfaces stale entries to the operator without blocking dispatch
- [x] #3 Tests cover all 4 status scenarios: completed/-file, tasks/-file + Done, tasks/-file + To Do, tasks/-file + In Progress
- [x] #4 Running frontier on current main shows only the genuinely-ready tasks (AISDLC-70, 115, 115.8, 125 in this state)
- [x] #5 PR body documents the underlying issue + manual `git mv` workaround for stale entries
<!-- AC:END -->
