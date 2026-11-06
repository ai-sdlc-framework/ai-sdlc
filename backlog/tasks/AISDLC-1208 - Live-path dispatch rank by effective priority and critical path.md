---
id: AISDLC-1208
title: 'Live-path dispatch rank by effective priority and critical path'
status: To Do
assignee: []
created_date: '2026-11-06'
labels:
  - rfc-0062
  - phase-1
  - dispatch ranking
dependencies: []
references:
  - spec/rfcs/RFC-0062-algorithm-improvement-directions.md
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/hierarchy/brief.ts
  - pipeline-cli/src/deps/effective-priority.ts
  - pipeline-cli/src/deps/dependency-graph.ts
priority: high
dispatchable: true
---

## Description

**Source.** RFC-0062 Phase 1 item 1, settled by OQ-2 (DEC-0386, 2026-11-06). Affected surface: the hierarchy claim order in `pipeline-cli/src/dispatch/board.ts` (`orderEligible`, comparator near line 415) and `PRIORITY_RANK` in `pipeline-cli/src/hierarchy/brief.ts`.

Today the live path sorts by `wave`, then a three-level rank with no `critical` entry (so a critical task sorts after low), then manifest mtime. Effective priority (RFC-0014, already computed and memoised by `effective-priority.ts` with `critical = 4`) and critical-path length (`dependency-graph.ts` longest path) are not consulted at all. Dispatch order is decided by file mtime more often than by priority.

## Scope

- Rank tuple, normative per RFC-0062 Design Details: `(wave, effectivePriority, criticalPathCost, ageBonus, id)`. `criticalPathCost` is the longest path to a sink with per-task cost 1 (the t-shirt midpoint and calibrated cost arrive in Phase 2); `ageBonus = clamp((ageDays − 30) / 180, 0, 1)`. Manifest mtime is no longer a key.
- `PRIORITY_RANK` gains `critical` ahead of `high`.
- Config key `dispatch.ranking: legacy | effective-priority`, default `legacy` for one release (Backward Compatibility section). In `legacy` mode the new rank is computed anyway and the first position where the two orders differ is logged to the board pane and the tick log (shadow comparison).
- RFC-0014 §5.2 is already amended to `max` in the walkthrough PR; the code already uses `max`. No formula change.

## Acceptance Criteria
- [ ] #1 With `dispatch.ranking: effective-priority`, a low-priority leaf that unblocks a critical task is claimed before an unrelated high task in the same wave (test with a three-task fixture).
- [ ] #2 Two tasks with equal effective priority order by critical-path length, then age bonus, then id; manifest mtime never changes the order (test shuffles mtimes).
- [ ] #3 `critical` sorts first under both modes; the `PRIORITY_RANK` test covers all four levels.
- [ ] #4 In `legacy` mode the board output contains one shadow line naming the first divergence between the two orders, or `ranking: identical`.
- [ ] #5 `docs/operations/cli-hierarchy.md` documents the key, the tuple and the one-release default.
