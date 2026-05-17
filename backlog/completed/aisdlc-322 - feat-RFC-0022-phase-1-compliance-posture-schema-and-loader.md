---
id: AISDLC-322
title: 'feat: RFC-0022 Phase 1 — CompliancePosture schema + loader + override-notes validation'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0022
  - compliance
  - phase-1
dependencies: []
references:
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 1 of RFC-0022 §9 Implementation Plan. Ships the schema + loader substrate that all later phases compose on.

## Scope (RFC-0022 §9 Phase 1)

- `spec/schemas/compliance-posture.v1.schema.json` — JSON Schema for `CompliancePosture` resource per §5.
- `orchestrator/src/compliance/types.ts` — TypeScript interfaces per §5.
- `orchestrator/src/compliance/loader.ts` — read `.ai-sdlc/compliance.yaml`, validate against schema, return parsed posture.
- `orchestrator/src/compliance/errors.ts` — `MissingComplianceAttestation`, `MissingDerivedGateOverrideNotes`, `UnknownRegime`, etc.
- Default ships with "(none declared)" baseline posture for projects without `.ai-sdlc/compliance.yaml`.
- **OQ-2 audit-trail enforcement:** loader rejects any `derivedGates` override missing `_notes` entry; `attestedAt` + `attestedBy` auto-filled at write time (CLI side; not at load time).
- **OQ-6 v2 forward-compat:** loader API returns `CompliancePosture[]` (single-element list in v1) — NOT `CompliancePosture` — so v2 multi-tenant is additive.
- Unit tests: schema validation; missing-attestation rejection; missing-override-notes rejection; default baseline returned on missing manifest.

## Exit criteria

Loader returns a `CompliancePosture[]`; gate readers can consume `posture[0].spec.derivedGates`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `spec/schemas/compliance-posture.v1.schema.json` ships per §5
- [ ] #2 `orchestrator/src/compliance/types.ts` exports TypeScript interfaces per §5
- [ ] #3 `orchestrator/src/compliance/loader.ts` reads `.ai-sdlc/compliance.yaml` + validates against schema
- [ ] #4 Loader API returns `CompliancePosture[]` (single-element list in v1) per OQ-6 v2 forward-compat constraint
- [ ] #5 Loader rejects override without `_notes` entry per OQ-2
- [ ] #6 Default baseline returned for projects without `compliance.yaml`
- [ ] #7 `errors.ts` exports `MissingComplianceAttestation`, `MissingDerivedGateOverrideNotes`, `UnknownRegime`
- [ ] #8 Unit tests cover schema validation + missing-attestation + missing-override-notes + default-baseline paths
<!-- AC:END -->
