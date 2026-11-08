---
id: AISDLC-1241
title: 'cli-file task --close: a sanctioned path that moves a superseded or withdrawn task to backlog/completed through a filing PR'
status: In Progress
assignee: []
created_date: '2026-11-08'
labels:
  - pipeline-cli
  - backlog
  - filing
dependencies: []
references:
  - pipeline-cli/src/cli/file.ts
  - pipeline-cli/src/hierarchy/superseded.ts
  - docs/operations/backlog-and-execution-reference.md
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
dispatchableReason: 'Filed by the planner on operator order 2026-11-08. AISDLC-1179.1 was superseded by AISDLC-1236 (DEC-0400) and cannot be closed: cli-file task --update edits a task in place and refuses a path under backlog/completed, and every other write to backlog/ by hand is unsanctioned (CLAUDE.md: file every backlog task with cli-file). The planner has carried this as an owed item through nine wakes.'
---

## Description

**Gap.** The backlog workflow says a task leaves `backlog/tasks/` only when its PR lands (the pipeline's step 10 moves it to `backlog/completed/`). A task that will never have a PR, because another task superseded it (AISDLC-1179.1 under DEC-0400), or because the operator withdrew it, has no sanctioned way out. `cli-file task --update` (`validateTaskFile` in `pipeline-cli/src/cli/file.ts`) resolves the existing path on `origin/main` and refuses when it is under `backlog/completed/`, and it never moves a file. The dispatch board separately refuses to reuse an id that was ever marked landed, so the superseded file lingers in `backlog/tasks/` as a `dispatchable: false` entry forever.

**Shape.** `cli-file task --close <id> --reason <text> [--superseded-by <id>] --pr`: reads the task from `origin/main`, sets `status: Done`, appends a `## Closed` section with the reason, the superseding id when given and the date, moves the file to `backlog/completed/` with the same filename, runs the same checks as a filing (ASCII, backlog-drift on inbound references, the governance gate's "no task files added by review tasks" is not triggered since this is a move), opens a filing PR on the `ai-sdlc/file-<id>` branch and arms it. It refuses when the id has an open PR, a live inflight claim or a queued manifest on the board, and when `--reason` is empty.

## Fix

**Five-step review (requirements first).**
1. Question: is a new subcommand needed, or can `--update` accept a `status: Done` edit and move the file? A move is a different operation from an in-place edit, and `--update` is also the path that caused the AISDLC-1235 reconciler bug, so a separate, explicit subcommand with its own refusals is the safer shape.
2. Delete: nothing.
3. Simplify: reuse `findOnMain`, the drift check and the filing branch code already in `file.ts`; the only new logic is the move, the `## Closed` section and the board refusals.
4. Accelerate: none.
5. Automate: unit tests for the refusals (open PR, inflight claim, queued manifest, empty reason, id already completed) and for the produced file (status, section, destination path, inbound references rewritten).

## Acceptance Criteria

- [ ] AC-1: `cli-file task --close AISDLC-1179.1 --reason "..." --superseded-by AISDLC-1236 --pr` (dry-run in tests) produces a filing branch whose only change moves the file to `backlog/completed/` with `status: Done` and a `## Closed` section.
- [ ] AC-2: the five refusals above are tested and name the condition in the error.
- [ ] AC-3: the reconciler treats the landed close PR as a filing (no task "landed" record, per the AISDLC-1235 fix); test added.
- [ ] AC-4: `docs/operations/backlog-and-execution-reference.md` documents the subcommand in a short paragraph next to `--update`.
- [ ] AC-5: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
