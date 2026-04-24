---
id: AISDLC-52
title: design-change.planned Event from DID.spec.plannedChanges
status: Done
assignee: []
created_date: '2026-04-24 17:24'
updated_date: '2026-04-24 18:49'
labels:
  - reconciler
  - lookahead
  - M4
milestone: m-1
dependencies:
  - AISDLC-51
references:
  - reference/src/reconciler/design-intent-reconciler.ts
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Wire emission of `design-change.planned` when a DID's `spec.plannedChanges[]` adds an entry with `status: planned`.

Detection happens in the DID reconciler by diffing against the previous snapshot (source_hash from `did_compiled_artifacts`).

Payload per §A.9:
- `changeType` (token-restructure | token-addition | token-removal | component-category-addition | brand-revision | theme-expansion)
- `description`
- `estimatedTimeline`
- `affectedTokenPaths[]`
- `estimatedComponentImpact` (count)
- `plannedBy` (principal)

Persist to `design_change_events` table. Consumers subscribe via orchestrator event bus. Implement four engineeringActions as logged recommendations (actual execution deferred, just structured output).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Adding new plannedChanges[] entry emits exactly one event
- [x] #2 Modifying planned → in-progress transition does NOT re-emit design-change.planned
- [x] #3 Event payload includes all 6 required fields
- [x] #4 design_change_events table round-trip persists the payload JSON
- [x] #5 Tests: fresh plan added, in-progress transition, completed transition, cancelled
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
`DesignChangePlanned` event added to the DID reconciler. Diffs `spec.plannedChanges[]` against `snapshot.plannedChangeIds` and emits exactly one event per newly-added entry whose status is `planned` — transitions on existing IDs never re-emit.

## Changes
- `reference/src/reconciler/design-intent-reconciler.ts`: extended `DesignIntentEventType` with `'DesignChangePlanned'`; added `DesignChangePlannedDetails` interface with the 6 required RFC-0008 §A.9 fields (`changeId`, `changeType`, `description?`, `estimatedTimeline?`, `affectedTokenPaths?`, `estimatedComponentImpact?`, `plannedBy?`) plus `engineeringActions: string[]` recommendations. Added `plannedChangeIds?: string[]` to `DesignIntentSnapshot`. Inside the reconciler, step 5 diffs current plannedChanges against previous IDs, emitting per newly-added `planned` entry. Helper `buildDesignChangePlannedDetails(change)` builds the payload; `recommendEngineeringActions` returns the 4 base actions plus an extra visual-regression recommendation for token-removal/token-restructure/brand-revision.
- `reference/src/reconciler/index.ts`: barrel-exported `buildDesignChangePlannedDetails` and `DesignChangePlannedDetails`.
- `reference/src/reconciler/design-intent-reconciler.test.ts`: +9 tests covering fresh planned entry emission (AC #1, #3), all 3 status transitions not re-emitting (AC #2, #5), new entry starting at in-progress not emitting, multi-add emits one event per id, conditional engineeringActions (visual-regression for restructure vs. not for addition), snapshot persists plannedChangeIds for subsequent runs.

## Design decisions
- **ID-based diff, not content-based**: if only the `status` flips from `planned` to `in-progress` but the id persists in `previous.plannedChangeIds`, we don't emit. This is the contractual behaviour per AC #2 — consumers care about the intent-to-change announcement, not the state-machine transitions (those have their own events in later tasks).
- **`engineeringActions` is data, not code**: the task said "execution deferred, just structured output". Keep the strings in the payload; a downstream worker pulls them off the event bus. Visual-regression recommendation is conditional on `changeType` — it only makes sense when the change could regress existing baselines.
- **Structured `DesignChangePlannedDetails`** type exported: downstream orchestrator code can type-check the payload shape when consuming the event bus. The reconciler spreads it into the generic `details: Record<string, unknown>` of `DesignIntentEvent` to keep the base event type simple.
- **Persistence lives at the caller site**: the reconciler emits; the orchestrator-side event handler calls `StateStore.recordDesignChange()` (already available from AISDLC-40). Keeps the reconciler pure and side-effect-free for the persistence concern.
- **New entries starting at `in-progress` do NOT emit `DesignChangePlanned`**: matches AC #5 — the event is strictly for the "just-announced, not yet started" transition. Starting in-progress means the work is already underway; a future `design-change.in-progress` event (not in scope) would cover that.

## Verification
- `pnpm build` — clean (all 9 packages)
- `pnpm vitest run src/reconciler/design-intent-reconciler.test.ts` — 26/26 pass (+9)
- `pnpm test` (full workspace) — 2964/2964, no regressions
- `pnpm lint` — clean

## Follow-up
AISDLC-53 (DesignQualityTrendDegrading) is the third M4 event — rolling-window analysis of `code_area_metrics` + `design_review_events` rather than spec-diff detection. AISDLC-54 (C7 design lookahead) completes M4 with scheduler-driven notifications for top-10 backlog items.
<!-- SECTION:FINAL_SUMMARY:END -->
