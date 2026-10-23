---
id: AISDLC-1073
title: 'cli-hierarchy spawn creates a per-task executor session and dynamic roster entry'
status: To Do
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

- [ ] `cli-hierarchy spawn aisdlc-1067` creates session `ai-sdlc-executor-aisdlc-1067` and a roster entry, and a second call reports the live session without creating another.
- [ ] With `AI_SDLC_EXECUTOR_TASK` set, `executor-start` claims only that task and exits non-zero with a named reason when it is not claimable; `--wait` under the variable is refused.
- [ ] A name failing the pattern is refused before any shell or tmux call.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
