---
id: AISDLC-291
title: 'feat: RFC-0035 Phase 7 — Capacity model + fatigue signal + decisions-config.yaml'
status: To Do
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0035
  - decision-catalog
  - phase-7
  - critical-path
dependencies:
  - AISDLC-285
  - AISDLC-306
  - AISDLC-283
references:
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - spec/rfcs/RFC-0016-estimation-calibration-tshirt-sizes.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 7 of RFC-0035 Implementation Plan (§14). Capacity composes with RFC-0016 calibrated t-shirt sizes (per OQ-6 resolution). Fatigue signal is non-blocking: defaults auto-apply, operator catches up retroactively (per fatigue-aware non-blocking convention).

## Scope

- Capacity model uses RFC-0016 calibrated t-shirt size as per-decision cost estimate
- Fatigue signal exposed via `cli-decisions fatigue {set, clear, status}`
- Decisions auto-deferred while fatigue set; defaults applied per OQ resolution
- `decisions-config.yaml` schema: per-org configurable timeboxes + thresholds
- Operator catches up retroactively via 24h override window from Phase 5
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Capacity model uses RFC-0016 calibrated t-shirt size as per-decision cost estimate
- [ ] #2 Fatigue signal exposed via `cli-decisions fatigue {set, clear, status}`
- [ ] #3 Decisions auto-deferred while fatigue set; defaults applied per OQ resolution
- [ ] #4 `decisions-config.yaml` schema: timeboxes + thresholds + override window all per-org configurable
- [ ] #5 Operator catches up retroactively (override window from Phase 5)
- [ ] #6 Schema documented in adopter-facing README
<!-- AC:END -->
