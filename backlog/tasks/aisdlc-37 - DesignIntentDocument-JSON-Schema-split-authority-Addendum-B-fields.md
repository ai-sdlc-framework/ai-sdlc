---
id: AISDLC-37
title: DesignIntentDocument JSON Schema (split-authority + Addendum B fields)
status: To Do
assignee: []
created_date: '2026-04-24 17:21'
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
- [ ] #1 Schema validates worked examples from RFC §4.2 and §B.3.2
- [ ] #2 identityClass enum: core, evolving
- [ ] #3 engineeringReview.blockingScope accepts detectionPatterns + visualConstraints.rule paths
- [ ] #4 Required: mission.value, ≥1 designPrinciples with ≥1 measurableSignal, designSystemRef.name
- [ ] #5 if/then: plannedChanges[].status=in-progress requires addedBy
- [ ] #6 Passes ajv draft 2020-12 compilation
<!-- AC:END -->
