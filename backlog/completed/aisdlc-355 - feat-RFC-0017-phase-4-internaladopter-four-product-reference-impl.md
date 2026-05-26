---
id: AISDLC-355
title: 'feat: RFC-0017 Phase 4 — InternalAdopter three-product suite (ProductA/B/C) as reference implementation; ProductD deferred to RFC-0018 per v0.4 (practitioner validation pass)'
status: Done
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

- **ProductA**: variants `small-utility`, `enterprise`, `county-regional` — validates audience-segment specialization across the v0.4 visual-token surface (color/density/typography/motion/radius).
- **ProductB**: variants `field-tech-on-truck`, `field-tech-handheld`, `supervisor-tablet` — validates density profile + form-factor specialization.
- **ProductC**: variants `billing-clerk`, `customer-portal`, `csr-dashboard` — validates role-based audience + workflow-density specialization.
- **ProductD**: **DEFERRED to RFC-0018 §11** per v0.4 Design Authority editorial pass. Proposed variants (`annual-test`, `repair-event`, `regulatory-audit-mode`) are temporal-context-bound operational modes activated by *when* and *why* a user is in the system — same user, different operational moment = Journey shape (RFC-0018), not Variant shape. ProductD validates the Variant/Journey boundary as a validation case for the companion RFC, not this one. **Scope of this task is now three products (A, B, C), not four.**

## Validation criteria (Mo's editorial welcome)

1. Each variant's design intent articulable in ≤ 5 `designImperatives` strings
2. No variant uses a field outside the §6.1 closed-enum schema (all overrides within the framework surface, OR validates the vendor-prefix extension path from OQ-5 if a real bespoke field surfaces)
3. Admission scoring on a real work item (e.g., "small-utility onboarding improvement") produces a different + better-justified score than soul-aggregate scoring
4. Engineering vertex confirms substrate is genuinely shared across all variants of each soul (no hidden divergence)
5. Deprecation lifecycle test: deprecate a variant; verify consumers degrade gracefully through full G0-routed lifecycle.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 ProductA variant declarations ship with `small-utility` / `enterprise` / `county-regional`
- [x] #2 ProductB variant declarations ship with `field-tech-on-truck` / `field-tech-handheld` / `supervisor-tablet`
- [x] #3 ProductC variant declarations ship with `billing-clerk` / `customer-portal` / `csr-dashboard`
- [x] #4 ProductD scope removed from this task per v0.4 (deferred to RFC-0018 §11 — temporal-context-bound modes are Journey shape, not Variant). No ProductD exports in reference impl; scope is confirmed three-product (A/B/C).
- [x] #5 Each variant has ≤ 5 `designImperatives` strings (validates closed-enum discipline OR exercises vendor-prefix extension)
- [x] #6 Admission scoring spot-check: variant-routed score differs from soul-aggregate by ≥ 15% on a representative work item (small-utility: sa1=0.91 vs soul-agg 0.55 = +65%)
- [x] #7 Engineering review confirms substrate shared across all four products' variants (substrate invariants validated in test suite)
- [x] #8 End-to-end deprecation lifecycle test on ProductA county-regional variant (all four transitions: declared → approaching → consumers-pending → removed)
<!-- AC:END -->
