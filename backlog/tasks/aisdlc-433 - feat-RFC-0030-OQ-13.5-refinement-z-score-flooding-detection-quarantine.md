---
id: AISDLC-433
title: 'feat: RFC-0030 OQ-13.5 re-walkthrough refinement — z-score flooding detection + quarantine + operator-unblock'
status: To Do
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
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Re-walkthrough refinement (2026-05-26) for RFC-0030 OQ-13.5 (adversarial signal injection). **Behavioral change — REPLACES the shipped detection algorithm**, not an additive layer.

## Replacement semantics (load-bearing)

The shipped substrate (`orchestrator/src/signal-ingestion/significance.ts`, AISDLC-346 in `backlog/completed/`) currently implements flooding detection as **`sourceBaselineDriftMultiplier × rolling baseline`** — a fixed-multiplier threshold against per-source baseline. This task REPLACES that algorithm with z-score detection on the same rolling baseline data.

- The `sourceBaselineDriftMultiplier` config field is **deprecated and removed** from `.ai-sdlc/signal-ingestion.yaml`.
- The new `flooding.detection.{zScoreThreshold, windowMinutes, minUniqueSourcesForSuspicion, baselineDays}` block REPLACES it (not "ships alongside").
- Migration: config-loader emits a `Decision: signal-ingestion-config-deprecated-field` if `sourceBaselineDriftMultiplier` is still present after this task ships; loader translates the legacy field to the closest z-score equivalent for one release window, then hard-errors on it after one full corpus window of adopters having time to migrate.
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

- Document in operator runbook: per-source reputation requires 7+ corpus windows of baseline data to calibrate reliably. Shipping with cold-start data = systematically biased against new sources. v2 ships once corpus accumulates.

### Hermetic tests

- z-score detector with synthetic spike traces (single-source flood, coordinated low-volume burst, baseline drift)
- Cold-start handling during first 7 days
- Quarantine duration respected; auto-expiry releases signals at expiresAt
- Operator unquarantine emits false-positive Decision with correct reference
- Per-org config overrides respected
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Existing multiplier-based detector at `orchestrator/src/signal-ingestion/significance.ts` (the `sourceBaselineDriftMultiplier × rolling baseline` path) is **deleted**, not left as a fallback. Z-score detector replaces it on the same per-source rolling-baseline data.
- [ ] #2 `sourceBaselineDriftMultiplier` config field deprecated + removed from `.ai-sdlc/signal-ingestion.yaml`; config-loader emits `Decision: signal-ingestion-config-deprecated-field` when legacy field is present; loader translates legacy → closest z-score equivalent for one release window; hard-errors after one full corpus window
- [ ] #3 Z-score detector implemented with per-org configurable thresholds (default 3.0σ, 60min window, 3 unique sources, 7d baseline)
- [ ] #4 Cold-start handling: <7d baseline → "calibrating" status, no Decisions; Tier 2 significance threshold sole defense
- [ ] #5 Trigger condition (`volume > baseline+3σ AND uniqueSources < 3`) emits `Decision: signal-flooding-detected`
- [ ] #6 Flooding signals marked `quarantined: true`; excluded from D1(cluster) formula in §10
- [ ] #7 Default 24h quarantine duration; per-org `flooding.quarantineDurationHours` override respected; auto-expiry at expiresAt releases signals
- [ ] #8 TUI batch-review surface has one-click "Unquarantine" action per flooding Decision (composes with RFC-0023 surfaces)
- [ ] #9 Unquarantine emits `Decision: signal-flooding-false-positive` with reference to original flooding Decision (v2 reputation-weighting calibration signal)
- [ ] #10 Operator runbook documents the multiplier-to-z-score migration AND algorithm + thresholds + quarantine semantics + cold-start behavior + v2 reputation deferral rationale
- [ ] #11 Hermetic tests cover all detection paths (single-source flood, coordinated burst, baseline drift), cold-start behavior, quarantine lifecycle, operator unquarantine path; legacy-config translation; deprecated-field Decision emission
<!-- AC:END -->
