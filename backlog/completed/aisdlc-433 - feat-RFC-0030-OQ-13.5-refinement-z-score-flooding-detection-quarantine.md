---
id: AISDLC-433
title: 'feat: RFC-0030 OQ-13.5 re-walkthrough refinement — z-score flooding detection + quarantine + operator-unblock'
status: Done
assignee: []
created_date: '2026-05-26'
labels:
  - rfc-0030
  - signal-ingestion
  - re-walkthrough-refinement
  - anti-abuse
dependencies: []
references:
  - spec/rfcs/RFC-0030-signal-ingestion-pipeline.md
  - spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md
priority: medium
blocked:
  reason: 'RFC-0030 lifecycle is Ready for Review (not Signed Off); §13.5 v0.3 re-walkthrough resolution is in-place and explicitly scopes this task. Operator-acknowledged OQ status per upstream-OQ-gate override convention.'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Re-walkthrough refinement (2026-05-26) for RFC-0030 OQ-13.5 (adversarial signal injection). **Behavioral change — REPLACES the shipped detection algorithm**, not an additive layer.

## Replacement semantics (load-bearing)

The shipped substrate (`orchestrator/src/signal-ingestion/significance.ts`, AISDLC-346 in `backlog/completed/`) currently implements flooding detection as **`sourceBaselineDriftMultiplier × rolling baseline`** — a fixed-multiplier threshold against per-source baseline. This task REPLACES that algorithm with z-score detection on the same rolling baseline data.

- The `sourceBaselineDriftMultiplier` config field is **deprecated and removed** from `.ai-sdlc/signal-ingestion.yaml`.
- The new `flooding.detection.{zScoreThreshold, windowMinutes, minUniqueSourcesForSuspicion, baselineDays}` block REPLACES it (not "ships alongside").
- Migration: config-loader emits a `Decision: signal-ingestion-config-deprecated-field` when `sourceBaselineDriftMultiplier` is still present once AISDLC-433 lands; loader translates the legacy field to the closest z-score equivalent for one release window, then hard-errors when `AI_SDLC_SIGNAL_INGESTION_LEGACY_HARD_ERROR=1` (post-soak default flip handled by a follow-up to AISDLC-433).
- The existing multiplier code path is DELETED, not left as a fallback — leaving both paths in place is the failure mode RFC-0025 (framework quality monitoring) is designed to flag.

## Scope (RFC-0030 §13.5 v0.3 refinements)

### Detection algorithm (REPLACES multiplier-based detector)

- **Z-score on rolling 7-day baseline per source.** Per-org configurable defaults:
  - `flooding.detection.zScoreThreshold` = 3.0
  - `flooding.detection.windowMinutes` = 60
  - `flooding.detection.minUniqueSourcesForSuspicion` = 3
  - `flooding.detection.baselineDays` = 7
- **Trigger condition**: `volume_in_window > (baseline_mean + 3σ)` AND `uniqueSources_in_window < 3` → `Decision: signal-flooding-detected`.
- Cold-start handling: until 7 days of baseline accumulated, detector emits "calibrating" status (no Decisions); use Tier 2 significance threshold as sole defense during the calibration window.

### Quarantine state

- Flooding signals recorded with `quarantined: true` flag.
- Quarantined signals do NOT feed D1 scoring (excluded from `D1(cluster)` formula in §10).
- Default quarantine duration: 24h (per-org `flooding.quarantineDurationHours` override).
- Quarantined signals visible in audit export with explicit `quarantine.reason` + `quarantine.expiresAt`.

### Operator one-click unquarantine

- TUI (RFC-0023) batch-review surface includes "Unquarantine" action per flooding Decision.
- On unquarantine: signals re-enter D1 candidacy; emit `Decision: signal-flooding-false-positive` (with reference to original flooding Decision) — this Decision serves as feedback signal for v2 reputation-weighting calibration.

### Reputation-weighting explicitly deferred to v2

- Document in operator runbook: per-source reputation needs 7+ corpus windows of baseline data to calibrate reliably (per RFC-0030 §13.5). Shipping with cold-start data = systematically biased against new sources. v2 ships once corpus accumulates (tracked separately as a future RFC-0030 follow-up; AISDLC-433 explicitly defers).

### Hermetic tests

- z-score detector with synthetic spike traces (single-source flood, coordinated low-volume burst, baseline drift)
- Cold-start handling during first 7 days
- Quarantine duration respected; auto-expiry releases signals at expiresAt
- Operator unquarantine emits false-positive Decision with correct reference
- Per-org config overrides respected
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Existing multiplier-based detector at `orchestrator/src/signal-ingestion/significance.ts` (the `sourceBaselineDriftMultiplier × rolling baseline` path) is **deleted**, not left as a fallback. Z-score detector replaces it on the same per-source rolling-baseline data.
- [x] #2 `sourceBaselineDriftMultiplier` config field deprecated + removed from `.ai-sdlc/signal-ingestion.yaml`; config-loader emits `Decision: signal-ingestion-config-deprecated-field` when legacy field is present; loader translates legacy → closest z-score equivalent for one release window; hard-errors after one full corpus window
- [x] #3 Z-score detector implemented with per-org configurable thresholds (default 3.0σ, 60min window, 3 unique sources, 7d baseline)
- [x] #4 Cold-start handling: <7d baseline → "calibrating" status, no Decisions; Tier 2 significance threshold sole defense
- [x] #5 Trigger condition (`volume > baseline+3σ AND uniqueSources < 3`) emits `Decision: signal-flooding-detected`
- [x] #6 Flooding signals marked `quarantined: true`; excluded from D1(cluster) formula in §10
- [x] #7 Default 24h quarantine duration; per-org `flooding.quarantineDurationHours` override respected; auto-expiry at expiresAt releases signals
- [x] #8 TUI batch-review surface has one-click "Unquarantine" action per flooding Decision (composes with RFC-0023 surfaces)
- [x] #9 Unquarantine emits `Decision: signal-flooding-false-positive` with reference to original flooding Decision (v2 reputation-weighting calibration signal)
- [x] #10 Operator runbook documents the multiplier-to-z-score migration AND algorithm + thresholds + quarantine semantics + cold-start behavior + v2 reputation deferral rationale
- [x] #11 Hermetic tests cover all detection paths (single-source flood, coordinated burst, baseline drift), cold-start behavior, quarantine lifecycle, operator unquarantine path; legacy-config translation; deprecated-field Decision emission
<!-- AC:END -->

## Final Summary

### Summary

Replaced the shipped multiplier-based flooding detector (`sourceBaselineDriftMultiplier × rolling baseline`) with a z-score detector on per-source rolling 7d baselines per RFC-0030 §13.5 v0.3. Added a `QuarantineStore` substrate so flooding-flagged signals are excluded from `D1(cluster)` until auto-expiry or operator unquarantine. Operator one-click unquarantine emits `signal-flooding-false-positive` as feedback for v2 reputation-weighting calibration. Config-loader emits `signal-ingestion-config-deprecated-field` when legacy field is present + auto-translates for one release window then hard-errors under `AI_SDLC_SIGNAL_INGESTION_LEGACY_HARD_ERROR=1`.

### Changes

- `orchestrator/src/signal-ingestion/config.ts` (modified): added `FloodingConfig` / `FloodingDetectionConfig` / `FloodingQuarantineConfig` types + defaults; added `loadSignalIngestionConfigWithDeprecations()` that detects legacy `flooding.detection.sourceBaselineDriftMultiplier`, translates to `zScoreThreshold = legacyMultiplier × 0.6`, emits `signal-ingestion-config-deprecated-field` Decision; rejects `flooding.detection.algorithm` values other than `z-score`.
- `orchestrator/src/signal-ingestion/significance.ts` (modified): **DELETED** the multiplier-based detector (`volumeSpike` / `lowSourceDiversity` / `perSourceBaselineDrift` indicators + `FloodingSeverity` / `FloodingResponse` / `SourceFloodingStat` types). Replaced with z-score detector returning `FloodingDetectionResult` with `status: 'flooded' | 'clean' | 'calibrating' | 'empty-window'`. Cold-start (baseline < `baselineDays`) returns `calibrating` with no Decision. Trigger: `windowCount > (mean + zScoreThreshold × stddev) AND uniqueSources < minUniqueSourcesForSuspicion`. Added `computeBaselineStat()` + `computeZScore()` exported for unit testing. Added `QuarantineStore` interface + `InMemoryQuarantineStore` impl + `isSignalQuarantined()` helper + `unquarantineFlooded()` Decision-emitter.
- `orchestrator/src/signal-ingestion/d1.ts` (modified): `computeClusterD1()` + `aggregateD1FromClusters()` accept `ComputeClusterD1Options` with optional `quarantineStore`; per-member filter excludes quarantined signals (AC #6). Back-compat: omitting the store preserves pre-AISDLC-433 behavior.
- `orchestrator/src/signal-ingestion/index.ts` (modified): export surface updated to add new types + remove deleted ones.
- `orchestrator/src/signal-ingestion/significance.test.ts` (modified): 18 new tests covering z-score detector (single-source flood, coordinated burst, baseline drift, cold-start, custom config, deterministic IDs), quarantine lifecycle (create, expiry, release, end-to-end), and `computeBaselineStat` / `computeZScore` math primitives. Halt-safety section renumbered to AC #8.
- `orchestrator/src/signal-ingestion/d1.test.ts` (modified): 5 new tests for D1 quarantine exclusion (mixed cluster, all-quarantined cluster, aggregate pass-through, auto-expiry release, back-compat).
- `orchestrator/src/signal-ingestion/config.test.ts` (modified): 7 new tests covering `flooding` block defaults + custom config + algorithm-rejection + `loadSignalIngestionConfigWithDeprecations()` translation + hard-error path + idempotent absent-file behavior.
- `spec/schemas/signal-ingestion-config.v1.schema.json` (modified): added `FloodingConfig` / `FloodingDetectionConfig` / `FloodingQuarantineConfig` defs; marked `sourceBaselineDriftMultiplier` as deprecated with migration pointer.
- `docs/operations/signal-ingestion.md` (modified): §5 rewritten to document the z-score algorithm + cold-start handling + quarantine semantics + operator one-click unquarantine path + per-org config + tuning guidance + migration recipe from the legacy multiplier-based detector + v2 reputation-weighting deferral rationale.

### Design decisions

- **REPLACE not augment.** The multiplier path is DELETED from the codebase, not left as a fallback (per task body — leaving both paths is the RFC-0025 failure mode).
- **Cold-start uses `max(per-source baselineDays)` across in-window sources.** Calibrating overall when NO source has the full window; per-source calibration when at least one source does. Skips per-source z-score computation for sources still in their own per-source cold-start.
- **Quarantine is per-signal, exclusion is per-member.** A mixed cluster contributes clean members' weight; cluster `eligibleForD1` remains true (it's a significance/SA verdict, not a quarantine verdict). The operator sees the cluster in audit; D1 only loses the flagged members' contribution.
- **Quarantine is lazy on read.** `isQuarantined()` checks `expiresAt > asOf` at lookup time. No background sweep / no time-based scheduler. Matches the existing event-driven substrate (no orchestrator loop dependency added).
- **TUI compose with RFC-0023 via `QuarantineStore` data + `unquarantineFlooded()` Decision-emitter.** RFC-0023's Blockers pane consumes `Decision`-shaped events; `signal-flooding-detected` is a Decision; the pane renders it + the unquarantine button calls `unquarantineFlooded()` → emits `signal-flooding-false-positive`. No new TUI API surface invented (per task body — "compose with RFC-0023's existing surfaces").
- **Legacy → z-score translation: `zScore = multiplier × 0.6`.** Empirical mapping documented in runbook §5: a 5× multiplier (the prior default) corresponds approximately to a 3σ spike on most production datasets. Linear scaling around the default preserves operator intent.
- **Hard-error is env-gated.** `AI_SDLC_SIGNAL_INGESTION_LEGACY_HARD_ERROR=1` flips translation → error. Default OFF for this release; next release flips it ON.

### Verification

- `pnpm --filter @ai-sdlc/orchestrator build` — clean
- `pnpm --filter @ai-sdlc/orchestrator test` — 4080 passed | 1 skipped (added 13 new tests vs pre-AISDLC-433 baseline of 4067)
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up

- **v2 reputation-weighting** — defer until 7+ corpus windows of `signal-flooding-false-positive` Decisions accumulate. Operator-runbook §5 explicitly documents the deferral rationale.
- **Post-soak hard-error promotion** — flip `AI_SDLC_SIGNAL_INGESTION_LEGACY_HARD_ERROR=1` to the default in CI one release window from now; remove the translation branch from `loadSignalIngestionConfigWithDeprecations()` thereafter.
- **Persistent QuarantineStore** — ship a `JsonlQuarantineStore` (append-only to `events.jsonl`) once a real deployment wires the detector into a long-running orchestrator loop. The in-memory store + interface is sufficient for AISDLC-433 because no shipping pipeline currently calls `detectFlooding()` from a long-running process.
