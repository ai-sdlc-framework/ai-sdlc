---
id: AISDLC-465
title: 'feat: RFC-0018 Phase 1 — Soul DID + Variant + Work Item schema additions (journeys[] + targetedJourneys) + journey count / state limits + inheritance validator + nested-journey rejection'
status: To Do
assignee: []
created_date: '2026-05-28'
labels:
  - rfc-0018
  - journey-pattern
  - phase-1
  - schema
dependencies: []
references:
  - spec/rfcs/RFC-0018-in-soul-journey-pattern.md
  - spec/rfcs/RFC-0017-in-soul-variant-pattern.md
  - spec/rfcs/RFC-0009-tessellated-design-intent-documents.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 1 of RFC-0018. Schema additions to Soul DID + Variant + Work Item; journey inheritance validator; count + state cardinality limits; nested-journey schema rejection.

## Scope (RFC-0018 §10.1 OQ-1 / OQ-2 / OQ-3 resolutions)

### Schema additions

- **Soul DID schema** (`spec/schemas/design-intent-document.schema.json`): add `journeys[]` array per §5.1 + §6.1
- **Variant schema** (RFC-0017 §5.1): add `journeys[]` array (variant-scoped journeys)
- **Work Item schema**: add optional `targetedJourneys[]` field with path-style URI format `<soul-id>/<journey-id>` OR `<soul-id>/<variant-id>/<journey-id>` per §6.1
- **Journey schema** (`spec/schemas/journey.v1.schema.json`): new file defining states / transitions / completionCriteria / accessibility / successMetrics / designImperatives / complianceFloor structure

### Journey inheritance validator

`orchestrator/src/journey/inheritance-validator.ts` (new module):
- Emits `JourneyInheritanceViolation` event when a journey attempts to:
  - Override `complianceRegimes` from parent
  - Lower WCAG level below parent (raising is permitted per §5.3)
  - Override `targetAudience` (inherits from soul or variant)
  - Override `substrateInvariants`
  - Set `complianceFloor` to anything other than `inherit` (when scope=variant)

### Count + state limits (OQ-1, OQ-2)

- Per-org configurable `.ai-sdlc/journey-config.yaml`:
  - `journey.limits.softWarnAt` (default 10) / `journey.limits.hardLimit` (default 50)
  - `journey.stateLimits.softWarnAt` (default 12) / `journey.stateLimits.hardLimit` (default 100)
- Decisions emitted per RFC-0035 G0 catalog routing:
  - `journey-count-soft-warning` (≥10 journeys; non-blocking batch review)
  - `journey-count-hard-limit-exceeded` (≥50 journeys; refuse declaration + clarification task)
  - `journey-state-count-soft-warning` (≥12 states; non-blocking; concrete message about v1 workaround)
  - `journey-state-count-hard-limit-exceeded` (≥100 states; refuse declaration + clarification task)

### Nested-journey rejection (OQ-3)

- Schema validation rejects `journeys[]` within Journey declaration (schema-enforced flat)
- Future-extensibility hook: `Decision: journey-sub-flow-activation-request` Stage A counter; auto-promote at ≥2 distinct adopter requests (no v1 activation surface; just the counter)

### Hermetic tests

- Schema round-trip for all new fields
- Inheritance violation emission for each constraint
- Count / state limit warnings + refusal at each threshold
- Nested-journey rejection at schema validation
- Per-org config override respect
- `targetedJourneys` URI parsing (soul-scoped + variant-scoped forms)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Soul DID schema has `journeys[]` array per §5.1 / §6.1
- [ ] #2 Variant schema (RFC-0017 §5.1) has `journeys[]` array
- [ ] #3 Work Item schema has optional `targetedJourneys[]` field with path-style URI parsing
- [ ] #4 `spec/schemas/journey.v1.schema.json` ships
- [ ] #5 `JourneyInheritanceViolation` event emitted for all 5 violation classes (compliance regimes / WCAG-below-parent / targetAudience / substrateInvariants / complianceFloor)
- [ ] #6 Per-org `journey-config.yaml` schema ships with `limits` and `stateLimits` blocks
- [ ] #7 Journey count thresholds emit correct Decisions (`journey-count-soft-warning` at ≥10; `journey-count-hard-limit-exceeded` at ≥50)
- [ ] #8 State count thresholds emit correct Decisions (`journey-state-count-soft-warning` at ≥12 with v1-workaround message; `journey-state-count-hard-limit-exceeded` at ≥100)
- [ ] #9 Nested `journeys[]` rejected at schema validation (OQ-3 schema-enforced flat)
- [ ] #10 `Decision: journey-sub-flow-activation-request` Stage A counter wired (no v1 activation surface; counter only)
- [ ] #11 Hermetic tests cover all validation paths + per-org override + URI parsing (soul-scoped + variant-scoped forms)
<!-- AC:END -->
