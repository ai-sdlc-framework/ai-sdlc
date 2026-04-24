---
id: AISDLC-37
title: DesignIntentDocument JSON Schema (split-authority + Addendum B fields)
status: Done
assignee: []
created_date: '2026-04-24 17:21'
updated_date: '2026-04-24 20:40'
labels:
  - schema
  - foundation
  - M1
milestone: m-1
dependencies: []
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
  - spec/schemas/design-system-binding.schema.json
  - spec/schemas/common.schema.json
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create `spec/schemas/design-intent-document.schema.json` covering RFC-0008 §4.2 + §B.3.2 structured extensions.

Key fields:
- `spec.stewardship` (split-authority per §4.4): `productAuthority` (mission, experientialTargets, constraints, scopeBoundaries, antiPatterns), `designAuthority` (designPrinciples, brandIdentity, voiceAntiPatterns, visualConstraints, visualAntiPatterns), `sharedAuthority` (designSystemRef.syncFields), `engineeringReview` (blockingScope on detectionPatterns and visualConstraints.rule), `reviewCadence: quarterly`
- `spec.soulPurpose`: mission (value + identityClass), constraints[] (with detectionPatterns), scopeBoundaries (inScope/outOfScope with synonyms), antiPatterns[], designPrinciples[] (with measurableSignals[] and scoped antiPatterns[])
- `spec.brandIdentity`: voiceAttributes, voiceAntiPatterns, visualIdentity (description, tokenSchemaRef, visualConstraints, visualAntiPatterns)
- `spec.experientialTargets`: onboarding, dailyUse, errorRecovery
- `spec.designSystemRef`: name, namespace, bindingType, syncFields
- `spec.plannedChanges[]`: Design→Engineering lookahead source (§A.9)
- `status`: lastReviewed, nextReviewDue, designSystemAlignment, ppaBinding
- `identityClass: 'core' | 'evolving'` on marked fields

Conditional `if/then`: planned change `status: in-progress` requires `addedBy`. Required: mission.value, ≥1 designPrinciples with ≥1 measurableSignal, designSystemRef.name.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Schema validates worked examples from RFC §4.2 and §B.3.2
- [x] #2 identityClass enum: core, evolving
- [x] #3 engineeringReview.blockingScope accepts detectionPatterns + visualConstraints.rule paths
- [x] #4 Required: mission.value, ≥1 designPrinciples with ≥1 measurableSignal, designSystemRef.name
- [x] #5 if/then: plannedChanges[].status=in-progress requires addedBy
- [x] #6 Passes ajv draft 2020-12 compilation
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
DesignIntentDocument JSON Schema landed — the foundation for RFC-0008. Covers §4.2 core fields (split-authority stewardship, soulPurpose, brandIdentity, experientialTargets, designSystemRef, plannedChanges) AND §B.3.2 structured extensions (constraints with detectionPatterns, scope synonyms, anti-patterns, measurable signals, identityClass markers).

## Changes
- `spec/schemas/design-intent-document.schema.json` (new, ~470 lines): JSON Schema Draft 2020-12 covering all §4.2 + §B.3.2 fields. `identityClass: core | evolving` enum on every markable leaf. Required: `spec.soulPurpose.mission.value`, `spec.soulPurpose.designPrinciples[]` with ≥1 entry each having ≥1 `measurableSignals`, `spec.designSystemRef.name`. Conditional `if/then`: planned change `status: in-progress` requires `addedBy`.
- `reference/src/core/validation.ts`: `DesignIntentDocument: 'design-intent-document.schema.json'` added to `SCHEMA_FILES` (AISDLC-38 wired validation).
- `reference/src/core/generated-schemas.ts`: regenerated via `generate-schemas.ts` to include the new schema inline.

## Verification
- Schema passes ajv draft 2020-12 compilation (verified via the reference package's schema-compile step in `pnpm build`)
- Worked examples from RFC §4.2 and §B.3.2 validate successfully (tested through the config loader in `orchestrator/src/config-did.test.ts`)
- 12 config-loader tests + 11 reference validation tests exercise the schema end-to-end

## Follow-up
Retroactively closed after full RFC-0008 implementation completed (see PR #63). Implementation merged in AISDLC-37 through AISDLC-67 work — 31 tasks total.
<!-- SECTION:FINAL_SUMMARY:END -->
