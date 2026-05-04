---
id: AISDLC-175
title: >-
  Orchestrator: filter parent-tasks-with-completed-children from frontier
  dispatch
status: To Do
assignee: []
created_date: '2026-05-04 00:13'
labels:
  - bug
  - orchestrator
  - rfc-0015
dependencies: []
references:
  - pipeline-cli/src/orchestrator/filters/
  - pipeline-cli/src/orchestrator/loop.ts
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Witness test of `cli-orchestrator tick` (2026-05-03) dispatched **AISDLC-70** (RFC-0010 parent task with all 9 sub-tasks already in `backlog/completed/`). The dev subagent did the right semantic thing — drafted a closure commit moving the parent file to `backlog/completed/` — but this is bookkeeping work that the framework should handle, not dispatch a developer subagent for. Worse: the same closure was already shipped via PR #231; the dispatch was a complete duplicate.

## Root cause

The pre-dispatch filter chain (RFC-0015 Phase 3 / AISDLC-169.3) doesn't recognize "parent task with all sub-tasks Done" as a non-dispatchable state. Filter chain currently checks: DoR readiness, dependency readiness, external dependencies. It does NOT check parent-task semantics.

## Fix

Add a new filter (e.g., `filters/orphan-parent.ts`) that, for any task with no declared `parentTaskId` whose ID is referenced as `parentTaskId` by ≥1 sub-task, refuses dispatch when ALL its sub-tasks are in `backlog/completed/`. The orchestrator should:
- Skip the task on the frontier
- Emit `OrchestratorOrphanParent` event so operator can close it manually OR add an automatic-close affordance
- Let the next ranked task be considered

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 New filter at pipeline-cli/src/orchestrator/filters/orphan-parent.ts wired into the chain composer
- [ ] #2 Filter detects parent tasks (referenced as parentTaskId by ≥1 sub-task) whose sub-tasks are all in backlog/completed/
- [ ] #3 Filter refuses dispatch with reason 'orphan-parent-needs-closure' and emits OrchestratorOrphanParent event
- [ ] #4 Unit tests cover: parent with all children done, parent with mixed children, parent with no children (not-an-orphan-parent), task with declared parentTaskId (not-a-parent)
- [ ] #5 Witness regression test: orchestrator tick against fixture with one orphan parent + one real bug task picks the bug task, not the orphan
<!-- AC:END -->
