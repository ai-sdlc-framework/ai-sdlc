---
id: AISDLC-435
title: 'feat: RFC-0017 Phase 1 — Soul DID + Work Item schema additions (variants[] + targetedVariants) + inheritance validator'
status: To Do
assignee: []
created_date: '2026-05-18'
labels:
  - rfc-0017
  - variant-pattern
  - phase-1
  - schema
dependencies: []
references:
  - spec/rfcs/RFC-0017-in-soul-variant-pattern.md
  - spec/rfcs/RFC-0009-tessellated-design-intent-documents.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 1 of RFC-0017 §9. Schema additions to Soul DID + Work Item + inheritance validator.

## Scope

- **Soul DID schema (`spec/schemas/design-intent-document.schema.json`)**: add `variants[]` array per §5.1. Each variant entry has `id`, `audience`, `designOverrides`, `complianceFloor: inherit` (locked).
- **`designOverrides` closed framework enum (v0.4 / OQ-5 revisit 2026-05-26)**: schema MUST accept ONLY `colorPaletteOverlay` (string), `densityProfile` (enum `compact`/`comfortable`/`spacious`), `typographyScale` (enum `default`/`large-print`/`data-dense`), `motionProfile` (enum `full`/`reduced`/`none`), `radiusProfile` (enum `sharp`/`default`/`rounded`). `voiceRegister` is **NOT** in the enum (cut in v0.4 per Mo's Design-Authority editorial pass — content register lives outside the visual token surface per 6/6 leading design systems). Adopter extensions via vendor reverse-DNS prefix (e.g. `acme.com/accessibilityProfile`) accepted; non-prefixed unknown keys rejected with `additionalProperties: false`.
- **Work Item schema**: add optional `targetedVariants[]` field (per OQ-6 URI format `did:method:platform:soul:<soul-id>/variant:<variant-id>`).
- **Variant inheritance validator** (`orchestrator/src/variant/inheritance-validator.ts`): emits `VariantInheritanceViolation` event when a variant attempts to escape substrate or compliance floor inheritance per §5.3.
- **Schema constraints** (OQ-1 + OQ-2): soft-warn at 5+ variants (emit Decision); hard-reject at 20+ variants; reject nested `variants[]` declarations (schema-enforced flat per OQ-2).
- **`.ai-sdlc/variant-config.yaml` schema** (per §10.1): defines per-org `variant.limits.softWarnAt` + `variant.limits.hardLimit` overrides; defaults 5 / 20.
- Unit tests: schema validation; inheritance violation detection; soft-warn at 5; hard-reject at 20; nested-variant rejection; per-org override.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Soul DID schema has `variants[]` array per §5.1
- [ ] #1a `designOverrides` closed enum accepts ONLY the v0.4 field set: `colorPaletteOverlay`, `densityProfile`, `typographyScale`, `motionProfile`, `radiusProfile` (each with the value-enum per §6.1). `voiceRegister` rejected. Vendor-prefixed keys (`<reverse-dns>/<field>`) accepted via `patternProperties`; non-prefixed unknown keys rejected.
- [ ] #2 Work Item schema has optional `targetedVariants[]` field with path-style URI format per OQ-6
- [ ] #3 Inheritance validator emits `VariantInheritanceViolation` event when substrate or compliance floor escape attempted
- [ ] #4 Variant count soft warning at 5+ emits `Decision: variant-count-soft-warning` (non-blocking)
- [ ] #5 Variant count hard limit at 20+ rejects declaration + emits `Decision: variant-count-hard-limit-exceeded` + clarification task
- [ ] #6 Nested `variants[]` rejected at schema validation (OQ-2 schema-enforced flat)
- [ ] #7 `.ai-sdlc/variant-config.yaml` per-org override schema ships
- [ ] #8 Unit tests for all validation paths + per-org override
<!-- AC:END -->
