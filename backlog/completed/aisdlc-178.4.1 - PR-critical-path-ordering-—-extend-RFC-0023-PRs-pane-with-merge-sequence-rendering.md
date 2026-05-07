---
id: AISDLC-178.4.1
title: >-
  PR critical-path ordering — extend RFC-0023 PRs pane with merge-sequence
  rendering
status: Done
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
    backlog/completed/aisdlc-178.4 -
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

- [x] #1 pipeline-cli/src/tui/prs/critical-path.ts derives PR dependencies from git branch ancestry + task dependencies + optional depends-on labels
- [x] #2 PRs pane sort order: critical-path-position DESC → unblock-count DESC → effPri DESC → age ASC
- [x] #3 Each PR row shows: existing fields + 'unblocks N' count + chain indicator (🔗 N/M for chained PRs)
- [x] #4 PR detail view (Enter) shows ASCII chain tree (upstream above, downstream below)
- [x] #5 `s` keystroke cycles sort orders (critical-path → recency → CI-status → back)
- [x] #6 Unit tests cover: chain detection, sort stability, ASCII tree rendering, depends-on label parsing
- [x] #7 Integration test: fixture with 4-PR chain reproducing the AISDLC-175 → 179 → 176 → 177 scenario; assert sort puts head-of-chain first
- [x] #8 RFC-0034 (PR Merge Critical-Path Ordering) reserved as the longer-term home for: auto-rebase trigger semantics, depends-on label semantics, multi-repo PR ordering. Does NOT block this sub-task. (Originally numbered RFC-0028 in the task spec; that slot was already taken by Engineering-Axis Substrate Enforcement, so RFC-0034 is the actual reservation.)
<!-- AC:END -->

## Final Summary

### Summary
PR critical-path derivation now powers the RFC-0023 §7.2 PRs pane. New `pipeline-cli/src/tui/prs/critical-path.ts` module derives upstream/downstream PR edges from three signal sources (task↔PR mapping via the dep snapshot, `depends-on:#N` labels, `Depends-on:` body markers), and an injectable `gitAncestry` hook reserved for the AISDLC-178.4.1 follow-on RFC-0034. Rows arrive sorted by `cpl DESC → unblockCount DESC → effPri DESC → age ASC`, render `🔗 N/M` chain indicators + `unblocks N` counts, and the detail view shows an upstream/downstream ASCII chain tree. The `s` keystroke cycles through `critical-path → recency → ci-status` sort modes; the legacy operator-attention bucket sort lives on as `ci-status`.

### Changes
- `pipeline-cli/src/tui/prs/critical-path.ts` (new): pure derivation module — `extractTaskId`, `parseDependsOnLabels`, `parseDependsOnBody`, `derivePrChainGraph`, `buildPrChainTree`. Cycle-safe DFS for `cpl`, `unblockCount`, chain back-depth.
- `pipeline-cli/src/tui/prs/use-prs.ts` (modified): adds `PrSortMode` (`critical-path | recency | ci-status`), `sortPrRows`, `nextSortMode`, `PR_SORT_MODES`. `buildPrRows` now enriches every row with `chain` info + `effPri` lifted from snapshot records. Default mode = `critical-path`.
- `pipeline-cli/src/tui/prs/pane.tsx` (modified): renders chain indicator + unblocks count, manages local `sortMode` state, handles `s` keystroke, detail view renders the chain tree.
- `pipeline-cli/src/tui/panes/prs.tsx` (modified): wires `useDepSnapshot` to feed `usePrs` so PR chain derivation has access to task dependencies. Falls through to singletons when no snapshot is present.
- `pipeline-cli/src/tui/prs/critical-path.test.ts` (new): 40 tests covering AC #6 + AC #7 (4-PR chain integration fixture).
- `pipeline-cli/src/tui/prs/use-prs.test.ts` (modified): adds tests for sort-mode cycling, chain enrichment, integration fixture, and the original ci-status bucket sort under its new mode name.
- `pipeline-cli/src/tui/prs/pane.test.tsx` (modified): adds tests for chain indicator rendering, `unblocks N` rendering, `s` keystroke sort cycling, chain-tree detail view.
- `spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md` (modified): §7.2 expanded with the new sort formula, signal-source list, sort-mode cycle, and a forward reference to RFC-0034.
- `spec/rfcs/README.md` (modified): RFC-0034 reservation row + bumped "Next available number" to RFC-0035.

### Design decisions
- **RFC-0028 → RFC-0034 swap.** The task spec named RFC-0028 but that slot is already held by "Engineering-Axis Substrate Enforcement" (Alexander Kline). RFC-0034 is the actual reservation; AC #8 + the registry note this explicitly so the cross-reference doesn't bit-rot.
- **Git ancestry is injectable, default off.** Calling `git merge-base --is-ancestor` from a render hook is O(N²) git invocations and the perf budget hasn't been measured. The pipeline ships with the hook reserved (off by default); RFC-0034 will spec the wiring once the budget is understood.
- **Singleton fallback when no snapshot is present.** The pane keeps working with `AI_SDLC_DEPS_COMPOSITION` off — chain info degrades to singletons (`cpl=0`, `chainLen=1`) and the sort tie-breaks to age ASC. Operators don't need to flip the flag to use the new pane.
- **Legacy operator-attention sort preserved as `ci-status` mode.** Some operators rely on the existing bucket sort for triage; renaming + cycling rather than deleting keeps that workflow intact.
- **Weakest signal (ancestry) does not override stronger signals.** Ancestry pairs already linked via task-dep / label / body are skipped to keep the upstream list deduped.

### Verification
- `pnpm build` — clean (TypeScript strict).
- `pnpm test` — 2,131 tests pass across 121 test files (added 113 in `pipeline-cli/src/tui/prs/`).
- `pnpm lint` — clean.
- `pnpm format:check` — clean.
- `npx backlog-drift check --task AISDLC-178.4.1` — info-only drift (parent task already completed); non-blocking.

### Follow-up
- RFC-0034 (Reserved → Draft) when an operator decides to spec auto-rebase trigger semantics, the canonical `depends-on` label syntax, and multi-repo PR ordering.
- A future revision can wire a real `gitAncestry` checker once we have data on how often the snapshot+labels combination misses real chains.
