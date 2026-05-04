---
id: AISDLC-179
title: >-
  Orchestrator: tick loop re-dispatches tasks already In Progress (no in-flight
  tracking)
status: To Do
assignee: []
created_date: '2026-05-04 02:48'
labels:
  - bug
  - orchestrator
  - rfc-0015
  - framework-bug
  - critical
dependencies: []
references:
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/orchestrator/index.ts
  - pipeline-cli/src/deps/
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Witness test of `cli-orchestrator start` (2026-05-04 ~02:30 UTC) on AISDLC-178.1: tick 1 dispatched the task, completed Steps 0-5 (worktree created, status flipped to In Progress, dev subagent prompt built — Step 5 is async dev subagent dispatch). Tick 2 fired 30s later and **re-dispatched the same AISDLC-178.1**, failing at Step 3 with "branch already exists" because tick 1's worktree was still occupied. Tick 3 fired and did the same. Each failed tick wastes a frontier-resolve + dispatch attempt.

## Root cause

The orchestrator's tick loop polls the frontier independently each tick. The frontier resolver (`cli-deps frontier` semantics) excludes tasks in `backlog/completed/` but does NOT exclude tasks with `status: In Progress`. With `maxConcurrent: 1` and a single in-flight task, EVERY subsequent tick sees the same task on top of the frontier and re-dispatches.

Looking at the data: the orchestrator's "in-flight" tracking should be:
- Either an in-memory map of `taskId → currentDispatch` consulted before each dispatch
- Or filter the frontier by `status != 'In Progress'`
- Or both

Today: neither. Tick 1's dev subagent runs asynchronously; tick 2 has no idea it's still running.

## Stderr observed

```
Likely cause: branch already exists. Run `/ai-sdlc cleanup AISDLC-178.1` first or pick a different task.
[orchestrator] escalation: task=AISDLC-178.1 reason=git worktree add failed for branch 'ai-sdlc/aisdlc-178.1-': ... branch named 'ai-sdlc/aisdlc-178.1-' already exists
```

## Severity

**Critical.** This makes `cli-orchestrator start` (the autonomous polling loop, RFC-0015 Phase 1's primary surface) effectively unusable — it spirals into wasted-dispatch loops the moment ANY dispatch takes longer than the tick interval (30s default). Real dispatches always take longer (dev subagent + reviewers + PR open is 5-15 min). So the loop fires 10-30 wasted dispatches per real one.

Per RFC-0025 framework-quality taxonomy: this is `framework-contract-violated` + `framework-silent-failure` — the orchestrator silently retries instead of recognizing in-flight state.

## Composes with AISDLC-175, 176, 177

- AISDLC-175 (orphan-parent filter) — separate concern
- AISDLC-176 (dev JSON contract retry) — separate concern  
- AISDLC-177 (rollback on dev-failed) — separate but adjacent: 177 cleans up after failures; THIS bug prevents the original dispatch from completing in the first place

This bug should ship FIRST among 175-177 + this one — without in-flight tracking, the others' fixes can't be tested cleanly because the orchestrator dispatches in parallel storms.

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 pipeline-cli/src/orchestrator/loop.ts maintains an in-memory map of in-flight task dispatches (taskId → dispatchPromise/state)
- [ ] #2 Pre-dispatch filter chain rejects any task whose ID is in the in-flight map; emits OrchestratorTaskAlreadyInFlight event with the existing dispatch ID
- [ ] #3 Frontier resolver additionally filters tasks with status: In Progress (defense in depth in case in-flight map is lost on restart)
- [ ] #4 On dispatch completion (success OR failure), task is removed from in-flight map
- [ ] #5 On orchestrator restart, in-flight map is reconstructed from filesystem (active worktree presence) so a restart doesn't re-dispatch tasks whose worktrees are still around
- [ ] #6 Unit tests cover: concurrent tick attempts on same task, restart-recovery, in-flight map cleanup on success + failure
- [ ] #7 Witness regression test: cli-orchestrator start with tick-interval-sec=2 and a fixture task that takes 10s; verify only ONE dispatch fires across the 5 ticks the test runs
<!-- AC:END -->
