---
id: AISDLC-183
title: >-
  Reviewer follow-up: AISDLC-179 missed AC #3 (frontier resolver In-Progress
  filter for defense-in-depth)
status: To Do
assignee: []
created_date: '2026-05-04 18:35'
labels:
  - bug
  - orchestrator
  - framework-bug
  - reviewer-finding
dependencies: []
references:
  - pipeline-cli/src/cli/deps.ts
  - pipeline-cli/src/orchestrator/in-flight.ts
  - >-
    backlog/completed/aisdlc-179 -
    Orchestrator-tick-loop-re-dispatches-tasks-already-In-Progress-no-in-flight-tracking.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Source
Code reviewer on PR #243 (AISDLC-179, retro review 2026-05-04) flagged that AC #3 of the original task was NOT addressed by the merged PR.

## Original AC #3 from AISDLC-179 spec
> Frontier resolver additionally filters tasks with status: In Progress (defense in depth in case in-flight map is lost on restart)

## What shipped
The PR added `reconstructInFlightFromWorktrees()` which covers restart-recovery from worktree sentinels. This is good but is NOT the same as filtering `status: In Progress` tasks at the frontier resolver layer.

## Failure mode the missing filter would prevent
If a sentinel ever vanishes mid-flight (operator runs `/ai-sdlc cleanup`, fs corruption, manual deletion) WITHOUT the task file being moved to `backlog/completed/`, the orchestrator can re-dispatch an In Progress task. This is exactly the failure mode AC #3 was framed to prevent.

## Fix
Add an explicit `status: In Progress` filter to the frontier resolver in `cli-deps frontier` semantics — either as part of the existing dependency-readiness filter chain OR as a separate filter at the resolver layer. Defense in depth alongside the in-flight map.

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 pipeline-cli/src/cli/deps.ts (or equivalent) excludes tasks with status: In Progress from the frontier output
- [ ] #2 Unit test: task in `backlog/tasks/` with status: In Progress is NOT in the frontier (current behavior likely returns it)
- [ ] #3 Integration test: orchestrator with empty in-flight map (simulating sentinel-loss scenario) does NOT re-dispatch a task whose file shows In Progress
- [ ] #4 Update AISDLC-179's AC #3 status to RESOLVED in its task file or revision-history note
<!-- AC:END -->
