---
id: AISDLC-178.4.1
title: >-
  PR critical-path ordering — extend RFC-0023 PRs pane with merge-sequence
  rendering
status: To Do
assignee: []
created_date: '2026-05-04 16:40'
labels:
  - rfc-0023
  - phase-4
  - prs
  - critical-path
dependencies:
  - AISDLC-178.4
references:
  - spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - pipeline-cli/src/deps/effective-priority.ts
  - >-
    backlog/tasks/aisdlc-178.4 -
    Phase-4-PRs-pane-Critical-Path-pane-—-replace-placeholders-with-real-implementations.md
parent_task_id: AISDLC-178.4
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Sub-task of AISDLC-178.4 (Phase 4: PRs pane + Critical Path pane).

## Problem

The framework has TASK-level critical path (RFC-0014's `effectivePriority DESC → criticalPathLength DESC → recency DESC → id ASC` in `cli-deps frontier`), but no equivalent for **PR merge ordering**. Operators currently mentally figure out which PR to merge first to unblock the most others, then trigger rebases reactively when conflicts surface.

## Why this is a real gap (operator burden)

Concrete recurring example: when wave-2 orchestrator bug PRs are in flight, the chain is:
```
#247 (175 orphan-parent filter) → #243 (179 in-flight tracking) → #176 (dev JSON retry) → 177 (rollback)
```
All touch `pipeline-cli/src/orchestrator/loop.ts`. Optimal merge order is the chain order; merging out-of-order produces rebase storms. Today the operator does this serially by reading task descriptions + branch names — exactly the kind of decision-burden the Decision Engine should automate.

## Implementation

Extend AISDLC-178.4's PRs pane with PR critical-path derivation:

1. **Derive PR dependencies** from two sources:
   - Git branch ancestry (PR B branched from PR A's branch → B depends on A)
   - Task dependencies via 1:1 task↔PR mapping (PR.task.dependencies → upstream PR list)
   - Optional `depends-on: #N` label/comment marker on the PR for cross-cutting cases

2. **Compute PR critical path**:
   - `prCriticalPathLength(PR_X) = max(prCriticalPathLength(PR_Y) for Y in downstream(X)) + 1`
   - Combined sort: `prCriticalPathLength DESC → unblock-count DESC → effPri DESC → age ASC`

3. **PRs pane row enhancements**:
   - New column: `unblocks N` (count of downstream PRs)
   - Visual indicator: `🔗 chain N/M` for PRs in a serial chain (this is PR N of M in the chain)
   - Sort order honors critical-path by default; `s` keystroke toggles to other sorts (recency, CI status, etc.)

4. **Chain visualization (Enter on a PR row)**:
   - Detail view shows ASCII tree of the PR's chain (upstream PRs above, downstream below)
   - Mirrors RFC-0023 §7.3 dep-tree rendering for tasks

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 pipeline-cli/src/tui/prs/critical-path.ts derives PR dependencies from git branch ancestry + task dependencies + optional depends-on labels
- [ ] #2 PRs pane sort order: critical-path-position DESC → unblock-count DESC → effPri DESC → age ASC
- [ ] #3 Each PR row shows: existing fields + 'unblocks N' count + chain indicator (🔗 N/M for chained PRs)
- [ ] #4 PR detail view (Enter) shows ASCII chain tree (upstream above, downstream below)
- [ ] #5 `s` keystroke cycles sort orders (critical-path → recency → CI-status → back)
- [ ] #6 Unit tests cover: chain detection, sort stability, ASCII tree rendering, depends-on label parsing
- [ ] #7 Integration test: fixture with 4-PR chain reproducing the AISDLC-175 → 179 → 176 → 177 scenario; assert sort puts head-of-chain first
- [ ] #8 RFC-0028 (PR Merge Critical-Path Ordering) reserved as the longer-term home for: auto-rebase trigger semantics, depends-on label semantics, multi-repo PR ordering. Does NOT block this sub-task.
<!-- AC:END -->
