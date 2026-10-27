---
id: AISDLC-1073
title: 'cli-hierarchy spawn creates a per-task executor session and dynamic roster entry'
status: Done
assignee: []
created_date: '2026-10-23'
labels:
  - pipeline-cli
  - hierarchy
priority: critical
dispatchable: true
dependencies: []
references:
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/roster.ts
  - pipeline-cli/src/hierarchy/executor-start.ts
  - spec/rfcs/RFC-0059-ephemeral-executors.md
rfc: RFC-0059
---

## Description

Add `cli-hierarchy spawn <task-id>` per RFC-0059. It derives the name `ai-sdlc-executor-<task-id-lowercase>`, validates it against `^ai-sdlc-executor-[a-z0-9-]+$`, creates the tmux session, registers a dynamic roster entry (role executor, task id, spawn time) and launches the interactive claude session (never `claude -p`) with the executor command and `AI_SDLC_EXECUTOR_TASK=<id>`. `executor-start` honours that variable: it claims exactly that task, refuses `--wait`, and never polls. A repeated spawn for a live name is a no-op.

**Five-step review (requirements first).** Requirement questioned: does a spawned executor need the claim loop at all? It needs one claim, so the loop is dropped. Deletion: the poll path under the env var. Simplification: name is a pure function of the task id. Acceleration: spawn is one command, seconds to a working session. Automation last: dispatch calls it (AISDLC-1074).

## Acceptance Criteria

- [x] `cli-hierarchy spawn aisdlc-1067` creates session `ai-sdlc-executor-aisdlc-1067` and a roster entry, and a second call reports the live session without creating another.
- [x] With `AI_SDLC_EXECUTOR_TASK` set, `executor-start` claims only that task and exits non-zero with a named reason when it is not claimable; `--wait` under the variable is refused.
- [x] A name failing the pattern is refused before any shell or tmux call.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.

## Final Summary

## Summary
Added `cli-hierarchy spawn <task-id>`. It validates the name `ai-sdlc-executor-<task-id-lowercase>` before any tmux or shell call, creates the session, writes a dynamic roster entry with `taskId`, and launches the interactive claude with `AI_SDLC_EXECUTOR_TASK`. `executor-start` under that variable claims only that task, never polls, refuses `--wait`, and exits 1 with a named reason when the task is not claimable or the board is held.

## Changes
- pipeline-cli/src/hierarchy/spawn.ts
- pipeline-cli/src/hierarchy/spawn.test.ts
- pipeline-cli/src/hierarchy/executor-start.ts
- pipeline-cli/src/hierarchy/executor-start.test.ts
- pipeline-cli/src/hierarchy/roster.ts
- pipeline-cli/src/hierarchy/validate.ts
- pipeline-cli/src/hierarchy/types.ts
- pipeline-cli/src/hierarchy/up.ts
- pipeline-cli/src/hierarchy/index.ts
- pipeline-cli/src/dispatch/board.ts
- pipeline-cli/src/cli/hierarchy.ts
- spec/schemas/hierarchy-roster.v1.schema.json
- reference/src/core/generated-schemas.ts
- docs/operations/cli-hierarchy.md
- backlog/tasks/AISDLC-1073 - hierarchy spawn per task executor and dynamic roster.md

## Design decisions
Test command: `pnpm test` from the worktree root. pipeline-cli summary: `Test Files 544 passed (544), Tests 12113 passed | 13 skipped`. Dark-code check passed. Commitlint rejects the scope `pipeline-cli`, so the commit uses `orchestrator`. Two design choices: the roster schema gains an optional `taskId` field, and `startedAt` is reused as the spawn time. Task ids containing `.` map to `-` in the session name. I did not run the coverage command.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

