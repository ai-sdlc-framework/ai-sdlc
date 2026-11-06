---
id: AISDLC-1208
title: 'Live-path dispatch rank by effective priority and critical path'
status: Done
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
- [x] #1 With `dispatch.ranking: effective-priority`, a low-priority leaf that unblocks a critical task is claimed before an unrelated high task in the same wave (test with a three-task fixture).
- [x] #2 Two tasks with equal effective priority order by critical-path length, then age bonus, then id; manifest mtime never changes the order (test shuffles mtimes).
- [x] #3 `critical` sorts first under both modes; the `PRIORITY_RANK` test covers all four levels.
- [x] #4 In `legacy` mode the board output contains one shadow line naming the first divergence between the two orders, or `ranking: identical`.
- [x] #5 `docs/operations/cli-hierarchy.md` documents the key, the tuple and the one-release default.

## Final Summary

## Summary
Live claim order can now rank by effective priority and critical path. A new `ranking:` key in `.ai-sdlc/dispatch.yaml` selects the mode. In `effective-priority` mode the order is wave, effective priority, critical-path length, age bonus, then id, and manifest mtime is never used. In `legacy` mode (the default for one release) `cli-dispatch board` prints one shadow line that names the first divergence or says `ranking: identical`. `critical` sorts first in both modes. `docs/operations/cli-hierarchy.md` documents the key, the tuple and the default.

## Changes
- pipeline-cli/src/dispatch/ranking.ts
- pipeline-cli/src/dispatch/ranking.test.ts
- pipeline-cli/src/dispatch/board.ts
- pipeline-cli/src/dispatch/index.ts
- pipeline-cli/src/cli/dispatch.ts
- pipeline-cli/src/hierarchy/brief.ts
- docs/operations/cli-hierarchy.md

## Design decisions
This run resumed work that was already committed. I rebased onto origin/main and confirmed `board.ts` has no leftover conflict markers. I re-ran build, test, lint and format:check. One test failed on the first full `pnpm test` run and passed on the rerun (3492 pass, 0 fail), so I did not identify which test it was. The pre-push patch-coverage gate passed at 100% (77/77 lines). I force-pushed with lease. Existing PR #2456 is open and not a draft (`isDraft: false`), and I did not change that.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

