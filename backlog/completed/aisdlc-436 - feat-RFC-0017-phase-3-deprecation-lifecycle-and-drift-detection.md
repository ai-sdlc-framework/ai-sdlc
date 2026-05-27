---
id: AISDLC-436
title: 'feat: RFC-0017 Phase 3 — variant deprecation lifecycle (catalog-routed) + Eτ_tessellation_drift extension + Engineering review routing'
status: To Do
assignee: []
created_date: '2026-05-18'
labels:
  - rfc-0017
  - variant-pattern
  - phase-3
dependencies:
  - AISDLC-435
  - AISDLC-353
references:
  - spec/rfcs/RFC-0017-in-soul-variant-pattern.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - spec/rfcs/RFC-0009-tessellated-design-intent-documents.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3 of RFC-0017 §9. Deprecation lifecycle per OQ-3 + Eτ_tessellation_drift extension for variant-scoped scans + Engineering review routing per OQ-7.

## Scope (OQ-3 deprecation lifecycle)

- **Lifecycle states** (catalog-routed per RFC-0035 G0):
  1. **Deprecation declared** → `Decision: variant-deprecation-declared` (log to catalog; no operator interrupt)
  2. **Approaching removal** (default 7d before removalDate; per-org config) → `Decision: variant-deprecation-approaching` → operator batch review surface
  3. **At removal date with consumers still referencing** → `Decision: variant-removal-consumers-pending` → **auto-action:** keep variant in degraded mode (don't break consumers) + emit migration tasks to consumer owners + surface to operator
- **30d default deprecation window**; per-Soul `deprecationWindowDays` override via `variant-config.yaml`.
- Pipeline never halts on any lifecycle transition (per G0).

## Scope (Eτ_tessellation_drift variant-scoped extension)

- Extend `Eτ_tessellation_drift` detector (composes with RFC-0009 Phase 4.2 / AISDLC-317) to scan variant-scoped design intent for drift.
- Variant drift detected → `Decision: variant-design-intent-drift` → catalog-routed per RFC-0035 Stage A/B/C.

## Scope (OQ-7 Engineering review routing)

- Variant declaration triggers `Decision: variant-substrate-cost-review` → Engineering Authority review via catalog.
- Engineering substrate-cost block → `Decision: variant-substrate-cost-block` → Design/Engineering routing per RFC-0029 actor model.
- Reviewer-subagent check (composes with AISDLC-298): variant declarations PRs without Engineering review Decision flag as critical.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Deprecation lifecycle: declared → approaching → at-removal-degraded-mode states all emit correct Decisions
- [ ] #2 30d default deprecation window; per-Soul override respected
- [ ] #3 Pipeline never halts on lifecycle transitions (consumers degrade gracefully at removalDate)
- [ ] #4 Eτ_tessellation_drift extended for variant-scoped scans; emits `Decision: variant-design-intent-drift`
- [ ] #5 Variant declaration triggers Engineering review Decision per OQ-7
- [ ] #6 Substrate-cost block routes via RFC-0029 actor model (Design + Engineering)
- [ ] #7 Reviewer-subagent flag (per AISDLC-298) on variant declarations without Engineering review Decision
- [ ] #8 Integration tests: full deprecation lifecycle + drift detection + Engineering review loop
<!-- AC:END -->
