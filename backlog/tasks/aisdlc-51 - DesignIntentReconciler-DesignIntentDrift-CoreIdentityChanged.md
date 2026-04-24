---
id: AISDLC-51
title: DesignIntentReconciler (DesignIntentDrift + CoreIdentityChanged)
status: Done
assignee: []
created_date: '2026-04-24 17:24'
updated_date: '2026-04-24 18:45'
labels:
  - reconciler
  - did
  - M4
milestone: m-1
dependencies:
  - AISDLC-39
  - AISDLC-40
references:
  - reference/src/reconciler/design-system-reconciler.ts
  - reference/src/reconciler/types.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create `reference/src/reconciler/design-intent-reconciler.ts` following `DesignSystemReconciler` factory pattern from RFC-0006.

Inputs: DID, resolved DSB, previous snapshot (from `did_compiled_artifacts.source_hash`).

Periodic check (quarterly per §4.4 but continuous per OQ-5 resolution) comparing DID `designPrinciples` against DSB `compliance.disallowHardcoded` and `designReview.scope`. Semantic check: each principle has at least one compliance rule mentioning concepts from its description (BM25-lite term match).

Emits events:
- `DesignIntentDrift` — DID principles no longer reflect DSB rules
- `CoreIdentityChanged` (Addendum B §B.9.1) — core identityClass field modified
- `EvolvingIdentityChanged` — evolving field modified (no backlog reshuffle)
- `ReviewOverdue` — review cadence exceeded
- `SoulGraphStale` — flag on in-flight items when core identity changes

Factory: `createDesignIntentReconciler(deps)`. Register in reconciler loop. Export from `reference/src/reconciler/index.ts`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Core field change emits CoreIdentityChanged with changedField path
- [x] #2 Evolving field change emits EvolvingIdentityChanged (no backlog reshuffle action attached)
- [x] #3 DID principle with no matching DSB compliance rule emits DesignIntentDrift
- [x] #4 Handler signature matches existing ReconcilerFn<DesignIntentDocument>
- [x] #5 Tests for each of 5 event types
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
`DesignIntentReconciler` landed following the `DesignSystemReconciler` factory pattern. Emits five event types (`CoreIdentityChanged`, `EvolvingIdentityChanged`, `DesignIntentDrift`, `ReviewOverdue`, `SoulGraphStale`) based on identity-class diffs against a previous snapshot and DSB coverage checks.

## Changes
- `reference/src/reconciler/design-intent-reconciler.ts` (new): `createDesignIntentReconciler(deps)` factory returning a `ReconcilerFn<DesignIntentDocument>`. Exports: `DesignIntentEventType`, `DesignIntentEvent`, `DesignIntentEventHandler`, `DesignIntentSnapshot`, `DesignIntentReconcilerDeps`, plus helpers `flattenIdentityFields`, `findPrinciplesWithoutDsbCoverage`, `extractKeywords`, `computeSourceHash`, `computeNextReviewDueMs`.
- `reference/src/reconciler/index.ts`: barrel-exported the new factory and helpers.
- `reference/src/reconciler/design-intent-reconciler.test.ts` (new): 17 tests — helper units (`extractKeywords`, `computeNextReviewDueMs`, `flattenIdentityFields`, `findPrinciplesWithoutDsbCoverage`), factory returns a `ReconcilerFn<>` (AC #4), snapshot persistence, core/evolving diff emission (AC #1/#2), DSB drift detection (AC #3), review-overdue, SoulGraphStale gating by in-flight count, error propagation via `ReconcileResult` instead of throw.

## Design decisions
- **Field-level identity-class flattening** over coarse hashing: AC #1 requires the changed-field path, so `flattenIdentityFields` walks every annotated leaf (mission, constraints, scope, anti-patterns, design principles + nested, brand identity, experiential targets) and returns `{path, identityClass, valueHash}`. Unannotated fields default to `evolving` — drift is still detected, it just doesn't trigger the backlog-reshuffle downstream (SoulGraphStale is gated on `core`).
- **FNV-1a 32-bit hex hash** (deterministic, non-crypto) as the default value hasher — JSON-serialize the subset + hash. `deps.hash` is injectable so production code can wire in a crypto-grade hash without changing the algorithm.
- **BM25-lite drift detection**: `findPrinciplesWithoutDsbCoverage` extracts keyword stems ≥4 chars from each principle description (stopwords removed, lowercased) and checks for at least one match in the DSB compliance rule corpus (hardcoded-disallow category/pattern/message + review scope). Principles with zero matches are emitted as drift. When DSB is missing, all principles are reported (signals that the ref is unresolved).
- **`SoulGraphStale` gated on `countInFlightItems`**: the dep is optional — absent it, we never emit (avoids false alarms in environments where the orchestrator can't query in-flight work yet). When present and core changed and count > 0, we emit with the count for downstream visibility.
- **`ReviewOverdue` uses simple cadence × days arithmetic** (monthly=30, quarterly=90, biannual=180, annual=365) with `deps.now` injection for deterministic tests.
- **Snapshot I/O injected**: the reconciler doesn't know about the state store; callers wire `getLastSnapshot` / `saveSnapshot` to `did_compiled_artifacts` rows (AISDLC-56 will do that wiring).
- **Errors captured in `ReconcileResult`**: matches the existing reconciler convention — the loop framework retries on `error` with exponential backoff; throws would crash the loop.

## Verification
- `pnpm build` — clean (all 9 packages)
- `pnpm vitest run src/reconciler/design-intent-reconciler.test.ts` — 17/17 pass
- `pnpm test` (full workspace) — 2017/2017 in reference (+17), no regressions elsewhere
- `pnpm lint` — clean

## Follow-up
AISDLC-52 emits `design-change.planned` events from `DID.spec.plannedChanges[]` diffs — same pattern, different source field. AISDLC-56 (M5) persists the snapshot into `did_compiled_artifacts` and wires the reconciler into the main loop.
<!-- SECTION:FINAL_SUMMARY:END -->
