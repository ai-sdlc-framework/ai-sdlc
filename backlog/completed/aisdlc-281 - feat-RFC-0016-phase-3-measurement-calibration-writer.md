---
id: AISDLC-281
title: 'feat: RFC-0016 Phase 3 — Measurement + monthly-rotated calibration writer'
status: Done
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0016
  - estimation-calibration
  - phase-3
  - critical-path-rfc-0035
dependencies:
  - AISDLC-280
references:
  - spec/rfcs/RFC-0016-estimation-calibration-tshirt-sizes.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3 of RFC-0016 Implementation Plan (§13). Pairs predicted estimates with actuals so signal #2 (historical actuals) becomes populated and class-default fallback retires gracefully.

## Scope

- Actuals collector recording start/finish per task
- Monthly-rotated `calibration-YYYY-MM.jsonl` writer (Q4 resolution)
- Non-work-time exclusion logic per §8
- Signal #2 (historical actuals) becomes populated as data flows
- Class-default seed values retire gracefully as real signal #2 takes over
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Actuals collector records start/finish per task
- [ ] #2 `calibration-YYYY-MM.jsonl` writer rotates monthly
- [ ] #3 Non-work-time excluded from elapsed-time computation per §8
- [ ] #4 For ≥10 completed tasks, paired predicted/actual records present
- [ ] #5 Signal #2 produces non-`unknown` values once n≥5 per class
- [ ] #6 Class-default fallback rate drops as calibration data accumulates (metric exposed)
<!-- AC:END -->
