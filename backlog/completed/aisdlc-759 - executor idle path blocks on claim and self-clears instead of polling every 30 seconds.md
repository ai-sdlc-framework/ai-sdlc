---
id: AISDLC-759
title: >-
  Executor idle path blocks on claim and self-clears instead of polling every 30 seconds
status: Done
assignee: []
created_date: '2026-10-08'
labels:
  - hierarchy
  - token-cost
  - rfc-0051
dependencies: []
references:
  - ai-sdlc-plugin/commands/executor.md
  - pipeline-cli/src/dispatch/
  - pipeline-cli/src/hierarchy/clear.ts
  - pipeline-cli/src/cli/hierarchy.ts
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Measured 2026-10-08: five executors per project poll an empty board every 30 s with about 8 calls per tick on a 250k to 560k context that is never cleared. That is about $13 per executor-hour of API weight for nothing, across 12 such sessions in ai-sdlc and ai-sdlc-io. Related: AISDLC-738. Full evidence: `docs/audits/2026-10-08-token-leak-loop-and-prose-automation-audit.md`.

## Scope

1. Add `cli-dispatch claim --wait <sec>` that blocks (fs.watch on the queue dir plus a poll floor) and returns only when a manifest is claimed or the timeout lapses.
2. Add `cli-hierarchy executor-start`, which does roster identity, check-repo, check-sender and the blocking claim in one deterministic call and returns JSON `{taskId|null}`.
3. Rewrite the executor.md empty-queue path: run executor-start with a 1,500 s wait; if null, run `cli-hierarchy clear --self --resume-after 30` (the same mechanism dispatch uses) so the next poll starts from the context floor; use `ScheduleWakeup 1800` only as the no-tmux fallback.
4. Default `emptyQueueHibernateSec` 1800, documented in docs/operations/cli-hierarchy.md.
5. Hermetic tests for the wait path and the wrapper.

Sequencing: none. Related: AISDLC-738; AISDLC-764 reuses the executor-start wrapper.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] AC-1: An idle executor makes zero LLM calls while blocked.
- [x] AC-2: An enqueue wakes a blocked executor within 5 s.
- [x] AC-3: Idle context after a clear is at the floor.
- [x] AC-4: executor.md is below 150 lines.
- [x] AC-5: New and existing tests pass.
<!-- AC:END -->
