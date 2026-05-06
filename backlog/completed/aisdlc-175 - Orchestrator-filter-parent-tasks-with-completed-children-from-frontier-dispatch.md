---
id: AISDLC-175
title: >-
  Orchestrator: filter parent-tasks-with-completed-children from frontier
  dispatch
status: Done
assignee: []
created_date: '2026-05-04 00:13'
updated_date: '2026-05-05'
labels:
  - bug
  - orchestrator
  - rfc-0015
dependencies: []
references:
  - pipeline-cli/src/orchestrator/filters/orphan-parent.ts
  - pipeline-cli/src/orchestrator/filters/orphan-parent.test.ts
  - pipeline-cli/src/orchestrator/filters/chain.ts
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/orchestrator/loop.filters.test.ts
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

- [x] #1 New filter at pipeline-cli/src/orchestrator/filters/orphan-parent.ts wired into the chain composer
- [x] #2 Filter detects parent tasks (referenced as parentTaskId by ≥1 sub-task) whose sub-tasks are all in backlog/completed/
- [x] #3 Filter refuses dispatch with reason 'orphan-parent-needs-closure' and emits OrchestratorOrphanParent event
- [x] #4 Unit tests cover: parent with all children done, parent with mixed children, parent with no children (not-an-orphan-parent), task with declared parentTaskId (not-a-parent)
- [x] #5 Witness regression test: orchestrator tick against fixture with one orphan parent + one real bug task picks the bug task, not the orphan
<!-- AC:END -->

## Implementation Notes

Shipped on main via commit `cc024a8` (`fix(orchestrator): filter orphan-parent tasks from frontier dispatch (AISDLC-175)`). The closure of this task file itself is the bookkeeping the AISDLC-175 filter would now skip — but this is the FIRST closure for AISDLC-175 (the cc024a8 commit shipped the implementation but did not move the file).

## Final Summary

### Summary
Adds an `OrphanParent` pre-dispatch filter that detects parent tasks whose every declared child is already in `backlog/completed/`. Witness was the 2026-05-03 dogfood run that picked up AISDLC-70 (RFC-0010 parent with 9 completed sub-tasks) even though PR #231 had already shipped the closure — pure bookkeeping the framework should handle, not real dispatch.

### Changes
- `pipeline-cli/src/orchestrator/filters/orphan-parent.ts` (new): pure detection — graph walk, short-circuits on (a) candidate is itself a child, (b) no children declared, (c) ≥1 open child; rejects only when ≥1 child exists AND every child is completed.
- `pipeline-cli/src/orchestrator/filters/orphan-parent.test.ts` (new): 4 AC #4 cases + 7 defensive cases (missing-from-graph, case-insensitive parent ref, self-reference, single-child quorum, case-insensitive candidate lookup, empty-string parent_task_id).
- `pipeline-cli/src/orchestrator/filters/chain.ts` (modified): wires `checkOrphanParent` as Filter 0 — runs FIRST because it's the cheapest + most decisive (an orphan parent isn't real work at all).
- `pipeline-cli/src/orchestrator/filters/types.ts` (modified): `FilterName` enum gains `'OrphanParent'`; `FilterDetail` union gains `OrphanParentDetail`.
- `pipeline-cli/src/orchestrator/filters/index.ts` (modified): re-exports `checkOrphanParent` + `OrphanParentDetail`.
- `pipeline-cli/src/orchestrator/events.ts` (modified): event-type union gains `'OrchestratorOrphanParent'`.
- `pipeline-cli/src/orchestrator/types.ts` (modified): `OrchestratorOrphanParentEvent` interface added; loop event union extended.
- `pipeline-cli/src/orchestrator/loop.ts` (modified): rejection branch maps `'orphan-parent-needs-closure'` → `OrchestratorOrphanParent` event with `completedChildren` payload.
- `pipeline-cli/src/orchestrator/loop.filters.test.ts` (modified): AC #5 witness regression test — fixture with one orphan parent + one real bug task; asserts orchestrator picks the bug task, skips the orphan, emits `OrchestratorOrphanParent` event.
- `pipeline-cli/src/deps/dependency-graph.{ts,test.ts}` (modified): `parentTaskId` field added to `DependencyNode`.
- `pipeline-cli/src/__test-helpers/make-task.ts` (modified): test helper extended.
- `spec/schemas/orchestrator-events.v1.schema.json` (modified): schema extended with `OrchestratorOrphanParent` + `completedChildren` field.
- `reference/src/core/generated-schemas.ts` (regenerated).
- `pipeline-cli/docs/orchestrator.md` (modified): documents the new filter.

### Design decisions
- **Filter 0 placement**: `OrphanParent` runs FIRST in the chain (before dependency-readiness), because it's a constant-time graph lookup AND the most decisive — an orphan parent isn't real work at all, so there's no point asking the costlier filters about it. The other three filters preserve the RFC §4.3 ordering among themselves.
- **"Candidate is itself a child" exclusion**: A task that carries a non-empty `parent_task_id` is treated as real work even if its own grandchildren are all completed. Closing a sub-task is real dispatch work — the orchestrator should keep working on it (matters for nested decompositions like AISDLC-100.7).
- **Case-insensitive matching**: On-disk frontmatter mixes `AISDLC-70` and `aisdlc-70` — both refer to the same parent. Matches the rest of the dependency graph's case-folding contract.
- **No reverse-index optimization**: O(N) linear walk over the node map is fine for backlogs in the 1000-task range (microseconds). Phase 4 / future RFCs can add a `parentId → childIds[]` index if the corpus shows the linear walk dominates orchestrator hot-loop time.

### Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 1750 tests passed (107 files)
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up
Optional automatic-close affordance for orphan parents (mentioned in the AISDLC-175 task description as an alternative to "operator closes manually"). Out of scope for this task; can be a future ticket if the orphan-parent event volume justifies it.
