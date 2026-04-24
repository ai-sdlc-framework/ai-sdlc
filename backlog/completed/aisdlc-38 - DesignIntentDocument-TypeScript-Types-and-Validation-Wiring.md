---
id: AISDLC-38
title: DesignIntentDocument TypeScript Types and Validation Wiring
status: Done
assignee: []
created_date: '2026-04-24 17:21'
updated_date: '2026-04-24 20:41'
labels:
  - types
  - foundation
  - M1
milestone: m-1
dependencies:
  - AISDLC-37
references:
  - reference/src/core/types.ts
  - reference/src/core/validation.ts
  - reference/scripts/generate-schemas.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow RFC-0006 pattern (AISDLC-10). Add 'DesignIntentDocument' to `ResourceKind` union in `reference/src/core/types.ts`. Currently: Pipeline, AgentRole, QualityGate, AutonomyPolicy, AdapterBinding, DesignSystemBinding.

Define interfaces:
- `DesignIntentDocumentSpec`, `StewardshipSplit`, `AuthorityScope`
- `SoulPurpose`, `MissionField`, `Constraint`, `ScopeBoundary`, `AntiPattern`, `DesignPrinciple`, `MeasurableSignal`
- `BrandIdentity`, `VoiceAntiPattern`, `VisualIdentity`, `VisualConstraint`, `VisualAntiPattern`
- `ExperientialTargets`, `DesignSystemRef`, `PlannedChange`
- `DesignIntentDocumentStatus`

Type alias: `DesignIntentDocument = Resource<'DesignIntentDocument', DesignIntentDocumentSpec, DesignIntentDocumentStatus>`. Add to `AnyResource` union. Add `DesignIntentDocument` entry to `SCHEMA_FILES` map in `reference/src/core/validation.ts:27`. Run schema regeneration script.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 ResourceKind includes 'DesignIntentDocument'
- [x] #2 AnyResource includes DesignIntentDocument
- [x] #3 validateResource(doc) auto-detects kind
- [x] #4 Schema generation script runs without errors
- [x] #5 All existing tests pass
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
DesignIntentDocument TypeScript types landed. `'DesignIntentDocument'` added to `ResourceKind` and `AnyResource` unions; 20+ supporting interfaces cover split-authority stewardship, soulPurpose (mission + constraints + scope + anti-patterns + designPrinciples + measurableSignals), brandIdentity (voice + visual + visualConstraints), experientialTargets, designSystemRef, plannedChanges, and DesignIntentDocumentStatus. Validation map updated; schema-generation script runs clean.

## Changes
- `reference/src/core/types.ts`: added `'DesignIntentDocument'` to `ResourceKind` union (now 7 kinds); added interfaces `IdentityClass`, `AuthorityScope`, `StewardshipSplit`, `MissionField`, `Constraint`, `ConstraintRelationship`, `ScopeTerm`, `ScopeBoundaries`, `AntiPattern`, `MeasurableSignal`, `MeasurableOperator`, `DesignPrinciple`, `SoulPurpose`, `DIDSyncField`, `DIDDesignSystemRef`, `VisualConstraintRule`, `VisualConstraint`, `VisualIdentity`, `BrandIdentity`, `ExperientialTarget`, `ExperientialTargets`, `PlannedChange`, `PlannedChangeType`, `PlannedChangeStatus`, `ReviewCadence`, `DesignIntentDocumentSpec`, `DesignIntentDocumentStatus`; type alias `DesignIntentDocument = Resource<'DesignIntentDocument', DesignIntentDocumentSpec, DesignIntentDocumentStatus>`; added to `AnyResource` union.
- `reference/src/core/types.test.ts`: updated ResourceKind test to expect 7 kinds.
- `reference/src/core/validation.ts`: added `DesignIntentDocument: 'design-intent-document.schema.json'` to `SCHEMA_FILES`.
- `reference/src/core/generated-schemas.ts`: regenerated via `scripts/generate-schemas.ts` — embeds the new DID schema inline.

## Verification
- `pnpm build` (reference) — clean, schema regeneration script runs without errors
- `validateResource(doc)` auto-detects kind on DID documents (tested via config-did.test.ts)
- All existing reference tests pass (1213 total)

## Follow-up
Retroactively closed after full RFC-0008 implementation completed (see PR #63).
<!-- SECTION:FINAL_SUMMARY:END -->
