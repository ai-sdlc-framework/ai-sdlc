---
id: AISDLC-279
title: 'feat: RFC-0016 Phase 1 — Stage A signals + class-default fallback'
status: In Progress
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0016
  - estimation-calibration
  - phase-1
  - critical-path-rfc-0035
dependencies: []
references:
  - spec/rfcs/RFC-0016-estimation-calibration-tshirt-sizes.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 1 of RFC-0016 Implementation Plan (§13). Ships the deterministic-only Stage A estimator behind feature flag `AI_SDLC_ESTIMATION_CALIBRATION=experimental`. Establishes the substrate every later phase composes on.

## Scope

- `cli-estimate stage-a <task-id>` command emitting candidate t-shirt bucket + per-signal breakdown
- Six cheap signal collectors: file scope, blocked paths, file-type breakdown, dependency depth, coverage requirement, LOC delta from planning
- Signal #9 class-default fallback (Q8 resolution): when historical actuals signal returns `unknown` (n<5 per class), fall back to catalogue median per class
- Pure-function bucket-lookup table (no LLM calls)
- Seed class-default buckets for the 3 starter classes: `bug` → S, `feature` → M, `chore` → S
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `cli-estimate stage-a AISDLC-X` returns candidate bucket + per-signal breakdown for any backlog task
- [ ] #2 Six deterministic signal collectors implemented per §5
- [ ] #3 Class-default fallback fires when historical-actuals signal returns `unknown` (n<5 per class)
- [ ] #4 No LLM calls in Stage A
- [ ] #5 Behind `AI_SDLC_ESTIMATION_CALIBRATION=experimental` feature flag (degrade-open when disabled)
- [ ] #6 Unit tests cover all six signals + class-default fallback path
<!-- AC:END -->
