---
id: AISDLC-466
title: 'feat: RFC-0018 Phase 2 — admission scorer composition (Sα₂ + Cκ + Eρ₅ journey routing) + completion-criteria closed enum + cross-journey aggregation'
status: To Do
assignee: []
created_date: '2026-05-28'
labels:
  - rfc-0018
  - journey-pattern
  - phase-2
  - admission-scoring
dependencies:
  - AISDLC-465
references:
  - spec/rfcs/RFC-0018-in-soul-journey-pattern.md
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
  - spec/rfcs/RFC-0017-in-soul-variant-pattern.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2 of RFC-0018. Admission scorer routes Sα₂ + Cκ + Eρ₅ scoring through journey-level design intent when work item declares `targetedJourneys`. Composes with RFC-0017 variant-scoped admission (`targetedVariants`).

## Scope (RFC-0018 §5.4 + §10.1 OQ-4 resolution)

### Journey-scoped scoring routing

`orchestrator/src/admission/journey-sa2-router.ts` (new module):

- **Sα₂ Vibe Coherence** — journey's `designImperatives` UNION variant's UNION soul's; conflict resolution most-specific wins (journey > variant > soul) per §5.4
- **Cκ Capability Coverage** — journey's `successMetrics` weighted at journey scope; if journey's `completion-rate` is BELOW `alertBelow` threshold, work that addresses this journey gets Cκ boost
- **Eρ₅ Compliance Clearance** — elevated when journey has explicit accessibility requirements above the soul floor (regulatory work on journey with `wcagLevel: AAA` gates more strictly than soul-default)

### Cross-journey aggregation

When work item targets multiple journeys, aggregate scores per `crossJourneyAggregation` config (default `min`; per-Soul override via `journey-config.yaml`). Matches RFC-0017 OQ-4 cross-variant aggregation pattern.

### Completion-criteria closed enum (OQ-4)

- Enum values for v1: `terminal-success-state`, `all-states-reached` only
- `custom-predicate` enum value rejected at schema validation
- `Decision: journey-custom-predicate-activation-request` Stage A counter wired; auto-promote at ≥2 distinct adopter requests
- Future-RFC documentation pre-recommends CEL (Google Common Expression Language) — captures industry consensus

### Backward compatibility

- Work items without `targetedJourneys` score against soul / variant (existing RFC-0017 behavior preserved)
- Soul DIDs without `journeys[]` behave identically (no journey scoring; existing scoring intact)

### Hermetic tests

- Sα₂ routing: single-journey, multi-journey aggregation with `min` default, per-Soul override
- Cκ boost when journey `completion-rate` below `alertBelow`
- Eρ₅ elevation when journey WCAG > soul-default
- Conflict resolution: most-specific wins (journey > variant > soul)
- Backward-compat: no `targetedJourneys` → soul/variant scoring
- Closed enum: `custom-predicate` rejected at schema validation
- Decision counter increments on each `journey-custom-predicate-activation-request`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Sα₂ scoring routes through journey `designImperatives` (UNION with variant + soul; most-specific wins) when `targetedJourneys` declared
- [ ] #2 Cκ scoring boosted when journey `successMetrics.completion-rate < alertBelow` threshold
- [ ] #3 Eρ₅ elevated when journey `accessibility.wcagLevel` > soul-default
- [ ] #4 Cross-journey aggregation: default `min`; per-Soul `crossJourneyAggregation` override respected
- [ ] #5 Closed completion-criteria enum: `terminal-success-state` + `all-states-reached` only; `custom-predicate` rejected at schema validation
- [ ] #6 `Decision: journey-custom-predicate-activation-request` Stage A counter wired
- [ ] #7 Work items without `targetedJourneys` score against soul/variant (backward-compat preserved)
- [ ] #8 Hermetic tests cover all scoring paths + conflict resolution + cross-journey aggregation + closed enum rejection + counter increments
<!-- AC:END -->
