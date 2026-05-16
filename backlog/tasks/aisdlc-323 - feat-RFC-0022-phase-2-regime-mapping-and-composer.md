---
id: AISDLC-323
title: 'feat: RFC-0022 Phase 2 — Regime → DerivedGates mapping + composer + control-feature-map'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0022
  - compliance
  - phase-2
dependencies:
  - AISDLC-322
references:
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2 of RFC-0022 §9 Implementation Plan. Ships the regime → controls mapping + composer + cross-reference doc.

## Scope (RFC-0022 §9 Phase 2)

- `spec/compliance/regime-mappings.yaml` — canonical mapping per §6 table; data, not schema.
- `orchestrator/src/compliance/composer.ts` — read regime list, look up each regime's derived gates from the YAML, compose with "tightest wins" semantics, apply operator overrides last.
- **OQ-1 adopter override:** composer reads `compliance.regimeOverrides` from `.ai-sdlc/compliance.yaml` and applies per-regime control overrides before the operator-override pass.
- `spec/compliance/control-feature-map.md` — hand-curated cross-reference of regime controls (e.g., SOC2 CC6.6) to AI-SDLC features. Structured markdown tables (parseable for tooling later). Reviewed annually per OQ-3 + per-RFC reviewer check (composes with OQ-7).
- Unit tests: each regime in §6 table → expected DerivedGates; multi-regime composition (SOC2+HIPAA, GDPR alone, etc.); operator-override precedence; **OQ-1 adopter regimeOverrides precedence test**.

## Exit criteria

Mapping table covers SOC2 / HIPAA / PCI-DSS / GDPR / FedRAMP / ISO-27001; tests assert tightest-constraint wins for each axis; operator overrides always win when notes present; adopter regimeOverrides apply correctly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `spec/compliance/regime-mappings.yaml` ships covering SOC2 / HIPAA / PCI-DSS / GDPR / FedRAMP / ISO-27001
- [ ] #2 `orchestrator/src/compliance/composer.ts` implements tightest-wins composition
- [ ] #3 Operator overrides applied last, always win when `_notes` present
- [ ] #4 OQ-1 adopter `regimeOverrides` applied per-regime before operator-override pass
- [ ] #5 `spec/compliance/control-feature-map.md` ships with structured markdown tables
- [ ] #6 Cross-reference includes per-feature evidence pointers for each shipped framework control
- [ ] #7 Tests: per-regime DerivedGates; multi-regime composition; operator-override precedence; adopter regimeOverrides precedence
<!-- AC:END -->
