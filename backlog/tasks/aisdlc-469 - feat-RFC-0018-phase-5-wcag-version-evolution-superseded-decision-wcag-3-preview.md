---
id: AISDLC-469
title: 'feat: RFC-0018 Phase 5 — WCAG version evolution (additive enum + superseded Decision + WCAG 3.0 scoring-model preview)'
status: To Do
assignee: []
created_date: '2026-05-28'
labels:
  - rfc-0018
  - journey-pattern
  - phase-5
  - accessibility
dependencies:
  - AISDLC-465
references:
  - spec/rfcs/RFC-0018-in-soul-journey-pattern.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5 of RFC-0018 §10.1 OQ-7 resolution. WCAG version evolution handling: additive enum + W3C-superseded advisory + WCAG 3.0 forward-compat documentation.

## Scope (OQ-7 WCAG version evolution)

### Additive enum behavior

- Existing journey declarations with WCAG 2.0 / 2.1 / 2.2 remain valid (no forced migration)
- New journey declarations can pick any currently-known version
- When a new WCAG version lands (e.g., WCAG 3.0 normative), framework adds it to the enum additively — no breaking change to existing declarations

### Superseded-version Decision

`orchestrator/src/journey/wcag-version-validator.ts`:

- W3C-superseded versions detected (currently: WCAG 2.0 — W3C recommends 2.1+)
- Emits `Decision: wcag-version-superseded` per RFC-0035 G0 catalog routing
- **Advisory only** — no Eρ₅ scoring impact, no scoring degradation, no PR block. Visible-gap signal for operator awareness.
- Severity: `low` (informational)

### WCAG 3.0 forward-compat documentation

`docs/operations/wcag-version-evolution.md`:

- Documents the WCAG 3.0 structural shift: binary conformance (2.x) → Silver framework graduated scoring (3.0)
- Notes that `conformanceTarget: number` field currently assumes binary; WCAG 3.0 may require new `scoringModel: 'binary' | 'graduated'` discriminant in a future RFC
- Pre-documenting the foreseeable scope so the future migration RFC author has context

### Hermetic tests

- Additive enum: declaring journey with WCAG 2.0 succeeds (with advisory Decision) AND declaring with 2.1 / 2.2 / future versions succeeds
- `Decision: wcag-version-superseded` emitted on 2.0 use; severity `low`; NO Eρ₅ impact
- Forward-compat: adding hypothetical WCAG 3.0 enum value doesn't break existing 2.x declarations
- Operator runbook section published and referenced from RFC-0018 §10 OQ-7 resolution
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `wcagVersion` enum is additive (existing declarations stable; new can pick latest)
- [ ] #2 `Decision: wcag-version-superseded` emitted when adopter declares WCAG 2.0 (W3C-superseded); severity `low`; advisory only
- [ ] #3 No Eρ₅ scoring impact from superseded-version Decision (visible-gap signal only)
- [ ] #4 `docs/operations/wcag-version-evolution.md` published with WCAG 3.0 forward-compat documentation
- [ ] #5 WCAG 3.0 scoring-model shift pre-documented (binary → graduated; may require `scoringModel` discriminant in future RFC)
- [ ] #6 Hermetic tests for additive enum behavior + superseded Decision + no-Eρ₅-impact invariant + forward-compat
<!-- AC:END -->
