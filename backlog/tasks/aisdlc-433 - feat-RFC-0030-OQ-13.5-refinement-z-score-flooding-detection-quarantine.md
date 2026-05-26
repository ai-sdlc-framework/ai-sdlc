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
Re-walkthrough refinement (2026-05-26) for RFC-0030 OQ-13.5 (adversarial signal injection). Lands on top of shipped Phase 4 substrate (AISDLC-346 in `backlog/completed/`).

## Scope (RFC-0030 §13.5 v0.3 refinements)

### Detection algorithm

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
- [ ] #1 Z-score detector implemented with per-org configurable thresholds (default 3.0σ, 60min window, 3 unique sources, 7d baseline)
- [ ] #2 Cold-start handling: <7d baseline → "calibrating" status, no Decisions; Tier 2 significance threshold sole defense
- [ ] #3 Trigger condition (`volume > baseline+3σ AND uniqueSources < 3`) emits `Decision: signal-flooding-detected`
- [ ] #4 Flooding signals marked `quarantined: true`; excluded from D1(cluster) formula in §10
- [ ] #5 Default 24h quarantine duration; per-org `flooding.quarantineDurationHours` override respected; auto-expiry at expiresAt releases signals
- [ ] #6 TUI batch-review surface has one-click "Unquarantine" action per flooding Decision (composes with RFC-0023 surfaces)
- [ ] #7 Unquarantine emits `Decision: signal-flooding-false-positive` with reference to original flooding Decision (v2 reputation-weighting calibration signal)
- [ ] #8 Operator runbook documents algorithm + thresholds + quarantine semantics + cold-start behavior + v2 reputation deferral rationale
- [ ] #9 Hermetic tests cover all detection paths (single-source flood, coordinated burst, baseline drift), cold-start behavior, quarantine lifecycle, operator unquarantine path
<!-- AC:END -->
