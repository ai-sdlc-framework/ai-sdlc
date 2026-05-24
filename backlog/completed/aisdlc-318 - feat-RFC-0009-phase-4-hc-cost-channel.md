---
id: AISDLC-318
title: 'feat: RFC-0009 Phase 4.3 — HC_cost channel (OQ-12, composes with RFC-0016 calibration)'
status: Done
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0009
  - tessellated-did
  - phase-4
  - cost-channel
dependencies:
  - AISDLC-313
references:
  - spec/rfcs/RFC-0009-tessellated-design-intent-documents.md
  - spec/rfcs/RFC-0016-estimation-calibration-tshirt-sizes.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4.3 of RFC-0009. HC_cost channel ships per §7.4 + OQ-12 resolution. Operator-tunable lever for per-task cost prediction; per-task cost-data quality grows with RFC-0016 calibration phases (crude → moderate → high).

## Scope (RFC-0009 §10 Phase 4, §7.4 HC_cost)

- HC_cost channel emits per-soul cost signals during admission per §7.4.
- Operator-tunable weight (default 1.0; per-org configurable in `.ai-sdlc/calibration.yaml`).
- Per-task cost-prediction quality scales with RFC-0016 calibration substrate:
  - **Crude** (RFC-0016 P1 shipped): bucket-class default per t-shirt class
  - **Moderate** (RFC-0016 P5 shipped): per-class calibrated bias-adjusted estimates
  - **High** (RFC-0016 P6 shipped): bias-corrected + drift-detected estimates
- Cost-quality tier surfaced to operator in `cli-admission` output so they know the confidence level of cost signals driving admission.
- Adopter opt-in gate respected (default off).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 HC_cost channel ships in admission composite per §7.4
- [x] #2 Operator-tunable weight via `.ai-sdlc/calibration.yaml` (default 1.0)
- [x] #3 Reads RFC-0016 calibration tier (crude/moderate/high) from estimate substrate
- [x] #4 Cost-quality tier surfaced to operator in `cli-admission` output
- [x] #5 Adopter opt-in gate (default off)
- [x] #6 Test coverage: each calibration tier produces sensible cost weights; opt-out short-circuits
<!-- AC:END -->
