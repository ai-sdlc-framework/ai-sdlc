---
id: AISDLC-284
title: 'feat: RFC-0016 Phase 6 — Soak + drift detection + class proposals'
status: Done
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0016
  - estimation-calibration
  - phase-6
  - critical-path-rfc-0035
dependencies:
  - AISDLC-283
references:
  - spec/rfcs/RFC-0016-estimation-calibration-tshirt-sizes.md
  - docs/operations/dor-promotion.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 6 of RFC-0016 Implementation Plan (§13). Corpus-driven (NOT calendar-gated) per maintainer directive 2026-05-01. Closes the calibration loop and supports promotion to default-on.

## Scope

- `EstimateBiasOverCorrected` event emitted on drift detection
- Weekly calibration digest
- Stage-A-coverage metric (% of estimates that bypass Stage B entirely)
- `cli-estimate-classes review` for operator approval of LLM-proposed new classes (Q3 resolution)
- Auto-promotion when ≥3 proposals of same shape accumulate
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `EstimateBiasOverCorrected` event emitted on detection
- [ ] #2 Weekly calibration digest generated and surfaced (TUI / Slack)
- [ ] #3 Stage-A-coverage metric tracked and exposed via `cli-estimates`
- [ ] #4 `cli-estimate-classes review` lists pending class proposals
- [ ] #5 Auto-promote when ≥3 proposals of same shape
- [ ] #6 Promotion criteria documented: 95%+ 1-bucket misses + <5% 3-bucket misses across 50 estimates AND Stage-A-coverage >70% AND class-proposal queue is operator-actionable
<!-- AC:END -->
