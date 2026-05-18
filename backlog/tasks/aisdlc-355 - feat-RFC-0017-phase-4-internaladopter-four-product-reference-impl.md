---
id: AISDLC-355
title: 'feat: RFC-0017 Phase 4 — InternalAdopter four-product suite as reference implementation (practitioner validation pass)'
status: To Do
assignee: []
created_date: '2026-05-18'
labels:
  - rfc-0017
  - variant-pattern
  - phase-4
  - practitioner-validation
dependencies:
  - AISDLC-352
  - AISDLC-353
  - AISDLC-354
references:
  - spec/rfcs/RFC-0017-in-soul-variant-pattern.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4 of RFC-0017 §9 + §11 practitioner validation. Implements InternalAdopter's four-product suite as the reference implementation; validates the variant pattern against real-world adopter constraints before final sign-off.

## Scope (§11 validation criteria)

- **ProductA**: variants `small-utility`, `enterprise`, `county-regional` — validates audience-segment specialization + voice register variation.
- **ProductB**: variants `field-tech-on-truck`, `field-tech-handheld`, `supervisor-tablet` — validates density profile + form-factor specialization.
- **ProductC**: variants `billing-clerk`, `customer-portal`, `csr-dashboard` — validates role-based audience + workflow-density specialization.
- **ProductD**: variants `annual-test`, `repair-event`, `regulatory-audit-mode` — validates temporal-context-bound design intent (also validates §11 carries through to RFC-0018 Journey companion).

## Validation criteria (Mo's editorial welcome)

1. Each variant's design intent articulable in ≤ 5 `designImperatives` strings
2. No variant requires a field NOT in the §6.1 schema (closed-enum holds; OR validates the vendor-prefix extension path from OQ-5 if a real bespoke field surfaces)
3. Admission scoring on a real work item (e.g., "small-utility onboarding improvement") produces a different + better-justified score than soul-aggregate scoring
4. Engineering vertex confirms substrate is genuinely shared across all variants of each soul (no hidden divergence)
5. Deprecation lifecycle test: deprecate a variant; verify consumers degrade gracefully through full G0-routed lifecycle.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 ProductA variant declarations ship with `small-utility` / `enterprise` / `county-regional`
- [ ] #2 ProductB variant declarations ship with `field-tech-on-truck` / `field-tech-handheld` / `supervisor-tablet`
- [ ] #3 ProductC variant declarations ship with `billing-clerk` / `customer-portal` / `csr-dashboard`
- [ ] #4 ProductD variant declarations ship with `annual-test` / `repair-event` / `regulatory-audit-mode`
- [ ] #5 Each variant has ≤ 5 `designImperatives` strings (validates closed-enum discipline OR exercises vendor-prefix extension)
- [ ] #6 Admission scoring spot-check: variant-routed score differs from soul-aggregate by ≥ X% on a representative work item
- [ ] #7 Engineering review confirms substrate shared across all four products' variants
- [ ] #8 End-to-end deprecation lifecycle test on one ProductA variant
<!-- AC:END -->
