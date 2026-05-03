---
id: AISDLC-167.2
title: 'Phase 2: PPA composition'
status: Done
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
- [x] #1 `effectivePriority(task) = max(priority(task), max priority across transitive downstream(task))` implemented in `pipeline-cli/src/deps/effective-priority.ts`. The aggregation is MAX (not the literal sum form in RFC §5.2 prose) to honour the §5.3 boundary contract: a 20-task chain doesn't get 20× boost — `maxDownstreamPriority` IS the cap.
- [x] #2 Dispatcher's priority comparator (`pipeline-cli/src/deps/dispatch.ts`, wired into `cli-deps frontier`) sorts by Q1 resolution: `effectivePriority DESC → criticalPathLength DESC → recency DESC` (with `id ASC` as the deterministic final tiebreak).
- [x] #3 Per-task `basePriority` scores are UNCHANGED by composition — `effective-priority.test.ts` asserts via a chain fixture that the basePriority for each node equals the priority weight written by the author regardless of where in the chain the task sits. The composition layer never writes back to PPA state.
- [x] #4 Composition is monotonic — `effective-priority.test.ts > monotonicity` adds a critical downstream and asserts upstream `effectivePriority` only INCREASES; adds a low-priority downstream and asserts upstream stays put.
- [x] #5 Q4 no-cache implementation: every `computeEffectivePriorities` call recomputes from scratch (returns a fresh Map; no module-level state; no TTL parameter on the API). Asserted in `effective-priority.test.ts > no-cache contract`.
- [x] #6 Integration test `dispatch.test.ts > AC #6: critical-path leaf-of-deep-chain bubbles to the top of the dispatch queue` — three frontier-eligible roots with shallow / deep / leaf-only downstream chains; expected order matches Q1 sort.
- [x] #7 Feature flag `AI_SDLC_DEPS_COMPOSITION` (already added in Phase 1) gates the new sort: flag OFF → baseline `id`-ASC order from `frontier()` (asserted in `dispatch.test.ts > feature flag OFF`); flag ON → depth-aware sort (asserted in `dispatch.test.ts > feature flag ON`). `forceComposition` / `forceBaseline` options expose A/B comparison for soak tooling.
- [x] #8 `pnpm --filter @ai-sdlc/pipeline-cli test` — 1153 passed (32 new tests). `pnpm typecheck` clean. `pnpm lint` clean. `pnpm format:check` clean.
<!-- AC:END -->

## Final summary

### Summary

RFC-0014 Phase 2 ships the depth-aware dispatcher composition. `cli-deps frontier` now sorts ready tasks by `effectivePriority DESC → criticalPathLength DESC → recency DESC` when `AI_SDLC_DEPS_COMPOSITION` is ON, so a low-priority leaf that unblocks a critical chain bubbles to the top of the dispatch queue automatically. Per-task PPA scores are unchanged; the composition is read-only for PPA per RFC §5.3.

### Changes

- `pipeline-cli/src/deps/effective-priority.ts` (new): pure `computeEffectivePriorities(graph, opts)` returning per-node `{basePriority, effectivePriority, criticalPathLength, lastModified}` records. Memoised cycle-safe DFS over reverse edges, O(V+E).
- `pipeline-cli/src/deps/dispatch.ts` (new): `sortFrontierByEffectivePriority(graph, frontier, opts)` + `compareForDispatch` + `rankAllByEffectivePriority`. Honours `AI_SDLC_DEPS_COMPOSITION` env flag with `forceComposition` / `forceBaseline` overrides for tests + soak A/B.
- `pipeline-cli/src/deps/dependency-graph.ts` (modified): `DependencyNode` gains a `priority: string` field (raw `priority:` frontmatter, lowercased + trimmed). `parseTaskFrontmatter` reads it.
- `pipeline-cli/src/cli/deps.ts` (modified): `cli-deps frontier` calls the new sort + emits `compositionEnabled` + `ranked` JSON fields. Table format gains EffPri + CPL columns. `frontier` array order matches `ranked` order so old consumers indexing `frontier[0]` get the dispatcher's first pick automatically.
- `pipeline-cli/src/deps/index.ts` (modified): re-export the new modules.
- `pipeline-cli/src/__test-helpers/make-task.ts` (modified): `writeTaskFile` accepts an optional `priority` to drive Phase 2 fixtures.
- `pipeline-cli/src/deps/effective-priority.test.ts` (new): 16 tests — bucket weights, resolver path, leaf, linear chain, branching diamond, fan-in, cycle (2-node + self-loop), monotonicity (both directions), no-cache.
- `pipeline-cli/src/deps/dispatch.test.ts` (new): 16 tests — flag OFF baseline preservation, flag ON Q1 sort (critical-path bubble, CPL tiebreak, recency tiebreak, id determinism), force flags, immutability, comparator unit, `rankAllByEffectivePriority` parity.
- `pipeline-cli/docs/deps.md` (modified): new "Phase 2 — depth-aware dispatcher composition" section documenting `effectivePriority`, the Q1 sort, no-cache + monotonicity contracts, the JSON output shape, and the library API.

### Design decisions

- **MAX not SUM** for `effectivePriority`. The RFC §5.2 prose writes `priority(task) + maxDownstreamPriority(task)` but §5.3 boundary contract immediately states the composition is "bounded by the graph depth — a 20-task chain doesn't get 20× boost". The AISDLC-167.2 task spec resolves the ambiguity to `max`. We follow the task spec; documented the choice in the source comment.
- **Backwards-compat JSON shape**. Old consumers indexing `frontier[0]` get the dispatcher's first pick automatically because we keep the `frontier` field but populate it in `ranked` order. The new `ranked` + `compositionEnabled` fields are additive — no caller breaks.
- **Pre-resolved priority on the node** (not a runtime resolver from the graph). `parseTaskFrontmatter` was already reading the raw frontmatter; surfacing `priority: string` keeps the comparator pure (no disk reads) and avoids a parallel resolver layer. The `priorityResolver` opt remains for tests that want synthetic values without touching disk.
- **Force flags for soak A/B**. RFC-0014 §11 Phase 5 measures dispatch quality with the flag off vs on; rather than fork the test surface or process-spawn twice, the `forceComposition` / `forceBaseline` options let one process compute both orderings against the same graph snapshot. Documented edge case (both set → composition wins).

### Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 1153 passed (32 new tests in `effective-priority.test.ts` + `dispatch.test.ts`)
- `pnpm typecheck` — clean (workspace-wide)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- `pnpm rfc:check` — clean (14 RFCs walked)
- `pnpm docs:check` — clean (sibling repo absent → expected pass)

### Follow-up

- **Phase 3** (AISDLC-167.3): DoR comment template extension reads `dependents` from the snapshot to compute blast-radius.
- **Phase 4** (AISDLC-167.4): Slack digest + dashboard graph view consume the same `effectivePriority` records this PR ships.
- **Phase 5** (AISDLC-167.5): corpus-driven soak — measure dispatch correctness with flag off vs on; promote when correctness > 95% AND no operator override-rate spike. The `forceComposition` / `forceBaseline` options on `sortFrontierByEffectivePriority` are designed for exactly this A/B comparison.
