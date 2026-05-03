---
id: AISDLC-167.2
title: 'Phase 2: PPA composition'
status: To Do
assignee: []
created_date: '2026-05-03'
labels:
  - rfc-0014
  - phase-2
  - ppa-composition
  - dispatcher
milestone: m-3
dependencies:
  - AISDLC-167.1
parent_task_id: AISDLC-167
references:
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - pipeline-cli/src/deps/
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2 of RFC-0014. Extend the dispatcher's priority comparator to use `effectivePriority(task) = priority(task) + maxDownstreamPriority(task)` so a low-PPA task that unblocks a high-PPA task inherits the downstream urgency. Critical-path leaves bubble to the top of the dispatch queue automatically. Per RFC §5.

The composition is **read-only for PPA**: per-task PPA scores in the calibration log are unchanged; only the dispatcher's sort order changes. Estimated 1 week.

## Open-question resolutions implemented in this phase

- **Q1 (tiebreak):** Dispatcher sort = `effectivePriority DESC → criticalPathLength DESC → recency DESC`. Structural signal (chain depth) strictly dominates arbitrary signal (recency) when effective priority is tied. An operator can trace "why this one?" as "longest chain → newest commit" without calibrating magic-number weights.
- **Q4 (no cache):** Recompute graph + `effectivePriority` per dispatch decision. O(V+E) is sub-millisecond at current scale (~150 tasks, ~200 edges). YAGNI on caching — adds invalidation bugs, an extra state surface, and operator confusion when manual edits don't show up immediately. Revisit only if profiling under realistic load shows recompute > 5% of decision time.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `effectivePriority(task) = priority(task) + maxDownstreamPriority(task)` implemented in the dispatcher; `maxDownstreamPriority` is the max PPA priority across `task.unblocks` transitive closure (NOT a sum — bounded by chain max per RFC §5.3)
- [ ] #2 Dispatcher's priority comparator updated to sort by Q1 resolution: `effectivePriority DESC → criticalPathLength DESC → recency DESC`
- [ ] #3 PPA per-task scores in the calibration log are UNCHANGED — composition is read-only for PPA per RFC §5.3 (assert via fixture: scores written by PPA scorer match scores read by composition layer)
- [ ] #4 Composition is monotonic: adding a new dependency edge can only INCREASE effective priority of upstream tasks, never decrease (assert via property test)
- [ ] #5 Q4 no-cache implementation: graph + `effectivePriority` recomputed per dispatch decision; no TTL state, no invalidation surface
- [ ] #6 Integration test with chain fixtures: critical-path leaf-of-deep-chain bubbles to top of dispatch queue; leaf-of-shallow-chain stays at its PPA-only rank
- [ ] #7 Behind feature flag `AI_SDLC_DEPS_COMPOSITION` (default off); when off, dispatcher behaves exactly as PPA-only baseline (assert via fixture comparison)
- [ ] #8 New code reaches 80%+ patch coverage; full workspace `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->
