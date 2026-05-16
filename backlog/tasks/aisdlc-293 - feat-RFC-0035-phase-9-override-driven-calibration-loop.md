---
id: AISDLC-293
title: 'feat: RFC-0035 Phase 9 — Override-driven calibration loop + pending-exemplars.yaml'
status: To Do
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0035
  - decision-catalog
  - phase-9
  - critical-path
dependencies:
  - AISDLC-289
  - AISDLC-306
references:
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 9 of RFC-0035 Implementation Plan (§14). Closes the calibration loop via the auto-apply + override window pattern from Phase 5. Per-org configurable override window (default 24h).

## Scope

- `pending-exemplars.yaml` writer on operator override (negative exemplars)
- Silent auto-apply (no override within window) → exemplar promoted to `decision-exemplars.yaml` (positive exemplars)
- Weekly digest summarises new pending exemplars
- `cli-decisions corpus aggregate` produces aggregated training corpus
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `pending-exemplars.yaml` writer on operator override
- [ ] #2 Silent auto-apply (no override within window) promotes to `decision-exemplars.yaml`
- [ ] #3 Weekly digest summarises new pending exemplars
- [ ] #4 `cli-decisions corpus aggregate` produces aggregated training corpus
- [ ] #5 Per-org configurable override window (default 24h)
- [ ] #6 Operator can re-affirm or re-classify pending exemplars via CLI
<!-- AC:END -->
