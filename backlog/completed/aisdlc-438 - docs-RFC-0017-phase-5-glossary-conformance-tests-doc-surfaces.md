---
id: AISDLC-438
title: 'docs: RFC-0017 Phase 5 — glossary additions + conformance test suite + adopter doc surfaces'
status: Done
assignee: []
created_date: '2026-05-18'
labels:
  - rfc-0017
  - variant-pattern
  - phase-5
  - docs
  - conformance
dependencies:
  - AISDLC-435
  - AISDLC-353
  - AISDLC-436
  - AISDLC-437
references:
  - spec/rfcs/RFC-0017-in-soul-variant-pattern.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5 of RFC-0017 §9. Adopter-facing surfaces + conformance gates + cardinality activation Decision wiring (OQ-8).

## Scope

### Glossary additions

- `Variant` — soul-scoped sub-theme with distinct visual identity + audience specialization, inheriting parent Soul DID's substrate + compliance
- `targetedVariants` — Work Item field declaring which variants the work applies to (path-style URI list)
- `complianceFloor: inherit` — locked field on variants; cannot be overridden (per RFC-0028 substrate-contract pattern)
- `Eτ_tessellation_drift` (variant-scoped) — design coherence drift detection within a single soul's variants

### Conformance test suite

- Variant declaration round-trip (write → read → schema validate)
- Admission-scoring composition: targetedVariants → variant-routed Sα₁/Sα₂
- Inheritance enforcement: complianceFloor escape attempt rejected; substrate divergence detected
- Cross-variant aggregation: default `min`; per-Soul override
- Deprecation lifecycle: declared → approaching → degraded-mode consumers
- Nested-variant rejection (OQ-2)
- Vendor-prefix designOverrides extension (OQ-5)
- Path-style URI parsing (OQ-6)

### Adopter doc surfaces

- `docs/concepts/variants.md` — introduction + when to use variant vs separate Soul
- `docs/tutorials/N-declaring-variants.md` — step-by-step variant declaration walkthrough using InternalAdopter examples
- `docs/operations/variant-deprecation.md` — deprecation lifecycle runbook + consumer-migration playbook

### OQ-8 cardinality activation Decision wiring

- `Decision: variant-cardinality-activation-request` registered in catalog substrate
- Stage A counter tracks adopter requests; auto-promote to operator batch review at ≥2 distinct requests
- Operator runbook documents the "file follow-on RFC for cardinality activation" path

### Promotion runbook

- `docs/operations/variant-pattern-promotion.md` — operator-driven default-on flip per RFC-0014 / RFC-0015 convention; corpus-driven (InternalAdopter validation must complete without regressions before promotion).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Glossary additions ship (Variant, targetedVariants, complianceFloor: inherit, Eτ variant-scoped)
- [ ] #2 Conformance test suite covers all 8 OQ resolutions + inheritance enforcement + cross-variant aggregation
- [ ] #3 `docs/concepts/variants.md` adopter-facing explainer ships
- [ ] #4 `docs/tutorials/N-declaring-variants.md` step-by-step walkthrough ships
- [ ] #5 `docs/operations/variant-deprecation.md` deprecation runbook ships
- [ ] #6 OQ-8 cardinality activation Decision registered + Stage A counter wired
- [ ] #7 Operator runbook documents the cardinality activation follow-on RFC path
- [ ] #8 Promotion runbook published; ties promotion to InternalAdopter validation completion
<!-- AC:END -->
