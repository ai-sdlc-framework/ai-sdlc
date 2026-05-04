---
id: AISDLC-177
title: >-
  Orchestrator: rollback task status + sweep worktree on developer-failed
  outcome
status: To Do
assignee: []
created_date: '2026-05-04 00:13'
labels:
  - bug
  - orchestrator
  - rfc-0015
dependencies: []
references:
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/orchestrator/playbook/
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - docs/operations/orchestrator-promotion.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Witness test of `cli-orchestrator tick` (2026-05-03): orchestrator dispatched AISDLC-70, Step 4 flipped status to "In Progress" + wrote `<worktree>/.active-task` sentinel, Step 6 failed with `outcome: "developer-failed"`. The orchestrator recorded the failure and exited — leaving:

- AISDLC-70 task status stuck at "In Progress" (was "To Do")
- Worktree `.worktrees/aisdlc-70/` left on disk with stale branch
- Active-task sentinel still present in worktree
- No event emitted indicating the side-effects need cleanup

Operator must manually: `git worktree remove --force .worktrees/aisdlc-70`, edit task file to revert status, delete sentinel.

## Fix

When `outcome: "developer-failed"` (or `outcome: "verification-failed"` from Steps 5b verifications), orchestrator MUST:
1. Revert task status back to its pre-dispatch value (typically "To Do") via `mcp__plugin_ai-sdlc_ai-sdlc__task_edit`
2. Remove the worktree (`git worktree remove --force <path>`) — sentinel goes with it
3. If the dev made commits on the branch (the AISDLC-70 case), do NOT discard — preserve the branch under a `quarantine/<task-id>-<timestamp>` ref AND emit `OrchestratorWorkQuarantined` event with the SHA so operator can recover via `git checkout quarantine/aisdlc-70-<ts>` + manual PR
4. Emit `OrchestratorRollback` event with `{taskId, fromStatus, toStatus, worktreeRemoved, branchQuarantined}` payload

This pattern composes with the existing 9-mode failure playbook (RFC-0015 Phase 2 / AISDLC-169.2).

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 loop.ts records pre-dispatch status before Step 4 status flip; persists in tick state for rollback path
- [ ] #2 On developer-failed: revert task status via task_edit before exit
- [ ] #3 On developer-failed: remove worktree via git worktree remove --force
- [ ] #4 Quarantine path: if dev made commits on the branch, ref-rename to quarantine/<task-id>-<timestamp> instead of discarding
- [ ] #5 Emit OrchestratorRollback event with {taskId, fromStatus, toStatus, worktreeRemoved, branchQuarantined, quarantineRef?}
- [ ] #6 Emit OrchestratorWorkQuarantined event when commits preserved
- [ ] #7 Failure-mode test: dispatch task, kill dev mid-step, verify rollback runs cleanly
- [ ] #8 Quarantine-recovery operator runbook entry in docs/operations/orchestrator-runbook.md
<!-- AC:END -->
