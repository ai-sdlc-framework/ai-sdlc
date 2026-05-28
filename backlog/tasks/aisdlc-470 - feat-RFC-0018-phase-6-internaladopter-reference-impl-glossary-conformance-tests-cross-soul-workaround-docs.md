---
id: AISDLC-470
title: 'feat: RFC-0018 Phase 6 — InternalAdopter accessibility-audit-pipeline reference impl + glossary + conformance tests + cross-soul workaround docs'
status: To Do
assignee: []
created_date: '2026-05-28'
labels:
  - rfc-0018
  - journey-pattern
  - phase-6
  - practitioner-validation
  - docs
dependencies:
  - AISDLC-465
  - AISDLC-466
  - AISDLC-467
  - AISDLC-468
  - AISDLC-469
references:
  - spec/rfcs/RFC-0018-in-soul-journey-pattern.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 6 of RFC-0018 §11 practitioner validation + glossary + conformance test suite + cross-soul journey workaround documentation (OQ-9).

## Scope (§11 InternalAdopter validation)

Implement the InternalAdopter accessibility audit pipeline as the reference implementation:

- **ProductA**: journeys `onboarding`, `daily-task-management`, `billing-inquiry-resolution` — multi-flow per soul; completion-rate + time-to-completion metrics
- **ProductB**: journeys `shift-start`, `route-completion`, `end-of-shift-handoff` — mobile form-factor accessibility (touch targets, voice commands)
- **ProductC**: journeys `csr-onboarding`, `customer-self-service`, `dispute-resolution` — variant-scoped journeys (csr vs customer-portal use same product but different journeys)
- **ProductD / annual-test variant**: journeys `submit-test-results`, `request-extension`, `view-historical-tests` — regulatory journey with elevated WCAG (`AAA` per state requirement)

## Scope (validation criteria)

1. Each journey's states + transitions form a valid state machine (no unreachable states, terminal states correctly marked)
2. WCAG audit reports map 1:1 to journey declarations (each audit has a target journey ID)
3. Admission scoring on a real work item produces higher score when targeted journey's completion-rate metric is below `alertBelow`
4. Variant-scoped journeys demonstrate journey-level WCAG elevation independently of soul-level

## Scope (glossary additions)

- `Journey` — temporally-ordered user flow within a Soul DID or Variant with distinct design intent, completion criteria, accessibility requirements, success metrics
- `targetedJourneys` — Work Item field declaring which journeys the work applies to (path-style URI list)
- `completionCriteria` — closed enum for v1: `terminal-success-state`, `all-states-reached` (CEL pre-recommended for v2)
- `MetricSnapshot` — operator-supplied numeric metric resource (per OQ-5)
- `JourneyStateIdDriftRule` — 4th rule in RFC-0009 §13 drift detection engine (per OQ-10)
- `auditOverdueGracePolicy` — per-Soul accessibility cadence enforcement mode: `graduated`, `binary-30d`, `hard-block`

## Scope (conformance test suite)

- Journey declaration round-trip (write → read → schema validate)
- Admission-scoring composition: targetedJourneys → journey-routed Sα₂ / Cκ / Eρ₅
- Inheritance enforcement: complianceFloor escape attempt rejected; WCAG-below-parent rejected
- Cross-journey aggregation: default `min`; per-Soul override
- Nested-journey rejection (OQ-3 schema-enforced flat)
- Completion-criteria closed enum: `custom-predicate` rejected
- Stale-metric handling: Decision emitted at threshold; Cκ warn-and-unknown behavior
- Graduated accessibility cadence: each threshold emits correct Decision + Eρ₅ impact
- WCAG version evolution: additive enum; superseded-version advisory; no Eρ₅ impact
- Drift detection: JourneyStateIdDriftRule via AST scan; positive + negative cases
- Cross-soul journey: per-soul-with-handoff pattern validates without framework-level cross-soul support

## Scope (cross-soul workaround docs, OQ-9)

`docs/operations/journey-cross-soul-workaround.md`:

- Per-soul-with-handoff pattern explained step-by-step
- Sample multi-product flow: ProductA onboarding → ProductB shift-start via shared `userId` correlation
- Each Soul owns its journey with `transitioned-to-soul-B` terminal state
- Operator-application owns cross-soul orchestration; framework scores per-soul only
- Cross-soul completion-rate computed by operator's analytics pipeline (not the framework)
- Future RFC reference: `Decision: cross-soul-journey-coordination-request` auto-promote at ≥2 distinct adopter requests
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 ProductA journey declarations ship with `onboarding` / `daily-task-management` / `billing-inquiry-resolution`
- [ ] #2 ProductB journey declarations ship with `shift-start` / `route-completion` / `end-of-shift-handoff`
- [ ] #3 ProductC variant-scoped journey declarations ship (csr vs customer-portal)
- [ ] #4 ProductD annual-test variant journey declarations ship with WCAG `AAA` elevation
- [ ] #5 Each journey passes state-machine validation (no unreachable states, terminal states correctly marked)
- [ ] #6 WCAG audit reports map 1:1 to journey declarations (verified via sample audit)
- [ ] #7 Glossary additions ship (6 terms)
- [ ] #8 Conformance test suite covers all 10 OQ resolutions + inheritance + cross-journey aggregation
- [ ] #9 `docs/operations/journey-cross-soul-workaround.md` published with per-soul-with-handoff pattern + sample multi-product flow
- [ ] #10 `Decision: cross-soul-journey-coordination-request` Stage A counter wired (no v1 activation surface)
- [ ] #11 Promotion runbook `docs/operations/journey-pattern-promotion.md` published; corpus-driven (InternalAdopter validation must complete without regressions before promotion)
<!-- AC:END -->
