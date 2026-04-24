---
id: AISDLC-67
title: SoulDriftDetected Event + CoreIdentityChanged Consumer
status: Done
assignee: []
created_date: '2026-04-24 17:27'
updated_date: '2026-04-24 19:57'
labels:
  - drift-monitor
  - reconciler
  - M6
milestone: m-1
dependencies:
  - AISDLC-63
  - AISDLC-51
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
§B.9.2. Create `orchestrator/src/sa-scoring/drift-monitor.ts`.

Continuous monitoring: trigger when rolling-30-day mean SA-1 (or SA-2) < 0.4 OR std-dev > 0.15 for 3 consecutive sprints.

Payload per §B.9.2:
- `dimension: SA-1 | SA-2`
- `rollingMean`, `rollingStdDev`, `sprintsInViolation`
- `trend: increasing | decreasing | stable`
- `driftSource` breakdown: `deterministicFlags`, `structuralScoreMean`, `llmScoreMean`, `note`

The `driftSource` breakdown distinguishes LLM-layer drift (exemplar bank miscalibration) from product drift (DID review needed). Three different remediation paths.

Emits `SoulDriftDetected` event + notifies design/product/engineering leads.

**Also**: Implement `CoreIdentityChanged` consumer (M4 reconciler emits this). Action per §B.9.1:
- `recompileAllArtifacts` — trigger M5 compilation
- `rescoreFullBacklog` — all non-in-flight items in priority order
- Emit `BacklogReshuffled` event
- Flag in-flight items `SoulGraphStale`

Create `orchestrator/src/sa-scoring/rescore-orchestrator.ts` for the consumer logic.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Synthetic 3-sprint declining mean triggers one event (hysteresis prevents daily re-fire)
- [x] #2 driftSource.structuralScoreMean separated from llmScoreMean; note distinguishes LLM-layer drift from product drift
- [x] #3 CoreIdentityChanged consumer triggers rescoreFullBacklog + BacklogReshuffled event + flags in-flight items SoulGraphStale
- [x] #4 Notification payload is structured JSON matching §B.9.2 template
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Final RFC-0008 task landed. `detectSoulDrift` monitors SA-1/SA-2 rolling statistics and emits `SoulDriftDetected` when three consecutive 30-day windows violate the mean/stddev thresholds. `handleCoreIdentityChanged` consumes the reconciler's event and orchestrates recompile → rescore → flag-in-flight, emitting `BacklogReshuffled`. The feedback loop closes: DID changes propagate back through the scorer and onto in-flight work.

## Changes
- `orchestrator/src/state/store.ts`: added `since?: string` filter to `getDidScoringEvents` so the drift monitor can scope to trailing windows.
- `orchestrator/src/sa-scoring/drift-monitor.ts` (new): `SoulDriftDetectedEvent`, `WindowStats`, `DriftTrend` types; pure helpers `mean`, `stddev`, `computeWindowStats`, `computeTrend`, `describeDriftSource` (categorises LLM-layer drift vs structural drift vs mixed-with-hard-gate vs uniform); `detectSoulDrift(dimension, deps)` orchestrator partitions scoring events into `consecutiveWindows` × `windowDays`-wide buckets, fires only when ALL windows violate; hysteresis via `getLastTriggerAt` with 7d default recovery. Constants: `DEFAULT_MEAN_THRESHOLD=0.4`, `DEFAULT_STDDEV_THRESHOLD=0.15`, `DEFAULT_CONSECUTIVE_WINDOWS=3`, `DEFAULT_WINDOW_DAYS=30`, `DEFAULT_RECOVERY_MS=7d`.
- `orchestrator/src/sa-scoring/rescore-orchestrator.ts` (new): `CoreIdentityChangedEvent`, `BacklogReshuffledEvent`, `SoulGraphStaleFlag` types; `handleCoreIdentityChanged(event, deps)` orchestrator invokes `recompileArtifacts` → `rescoreFullBacklog` → `flagInFlight` in order, returns `BacklogReshuffledEvent` with counts. Supports sync or async callbacks, injected clock, no-op skip when DID unresolved.
- `orchestrator/src/sa-scoring/drift-monitor.test.ts` (new): 20 tests — mean/stddev arithmetic, trend classification (increasing/decreasing/stable) with 0.05 tolerance, driftSource note variants (AC #2), window stats JSON parsing + hardGate counting, stddev-only violation path, 3-consecutive-windows fires once (AC #1), 2-of-3 does not fire, hysteresis blocks re-fire within recovery (AC #1), re-fires after recovery, LLM vs structural mean separation in driftSource (AC #2), notifiedPrincipals union (AC #4), empty-events skip, default thresholds match spec.
- `orchestrator/src/sa-scoring/rescore-orchestrator.test.ts` (new): 6 tests — invocation order recompile→rescore→flag + BacklogReshuffled payload (AC #3), skip path when DID unresolved, mixed sync/async callback support, injected clock timestamps, error propagation from rescore, zero-in-flight empty-array path.
- `orchestrator/src/index.ts`: exported new public API.

## Design decisions
- **Windows walked newest-first** in both drift detector and trend computation — matches state-store ordering and makes "direction of change" consistent (newest vs oldest).
- **`describeDriftSource` classifies drift via 0.15 LLM-vs-structural gap**: wide enough to signal a real layer divergence, narrow enough to catch meaningful asymmetry. Below that we check for hard-gate flags as the tiebreaker. Default is "uniform drift → product review" — the most likely root cause when both layers agree something is off.
- **Consumer takes callbacks, not concrete implementations**: `recompileArtifacts`, `rescoreFullBacklog`, `flagInFlight` are all injectable. The consumer orchestrates order and emits `BacklogReshuffled` — it doesn't know about the admission pipeline, state store, or issue tracker. Testability + future reusability across multiple event kinds (CoreIdentityChanged today, potentially SoulDriftDetected consumers later).
- **Rescore before flag**: the backlog contains items admitted before the identity change. After recompile, we rescore them against the new DID. In-flight items (separate set) get flagged after so their flag metadata reflects the post-rescore state. Same ordering the RFC spec implies.
- **Hysteresis separate from violation detection**: the detector's pure window logic doesn't know about hysteresis. `detectSoulDrift` applies the recovery-window check before running windowing. This split makes unit tests tractable — window math tested without lastTriggerAt coupling.
- **`hardGated` flag parsed from layer1_result_json**: `computeWindowStats` increments `deterministicFlags` when layer 1 short-circuited. `describeDriftSource` uses this as a tiebreaker ("Mixed drift with N hard-gated events" when structural and LLM means are balanced but hard-gate events are present).
- **`BacklogReshuffled` ALWAYS emitted** (even with 0 rescored, 0 flagged) when the DID resolved. Gives downstream event consumers a predictable heartbeat per CoreIdentityChanged. The `skipped` boolean signals the no-op path separately.

## Verification
- `pnpm build` — clean (all 9 packages)
- `pnpm vitest run src/sa-scoring/drift-monitor.test.ts src/sa-scoring/rescore-orchestrator.test.ts` — 26/26 pass
- `pnpm vitest run` (full orchestrator) — 2256/2256 pass (+26)
- `pnpm test` (full workspace) — no regressions
- `pnpm lint` — clean

## RFC-0008 implementation complete
All 6 milestones (M1–M6), 31 tasks (AISDLC-37 through AISDLC-67) delivered:
- M1: DID resource foundation + C1 SA-2 computable half
- M2: C2/C3/C4/C5 enrichment bridge
- M3: §A.6 admission composite + pillar breakdown + CLI integration
- M4: DesignIntentReconciler + design-change events + trend/lookahead detectors
- M5: Python sidecar + three-layer SA scoring + SA-1/SA-2 composite + pattern-test CLI + exemplar bank + orchestration
- M6: Feedback flywheel + C6 category calibration + phase-weight auto-calibration + drift monitor + CoreIdentityChanged consumer

The feedback loop is closed: feedback signals → category calibration → phase-weight shifts → scoring → new feedback.
<!-- SECTION:FINAL_SUMMARY:END -->
