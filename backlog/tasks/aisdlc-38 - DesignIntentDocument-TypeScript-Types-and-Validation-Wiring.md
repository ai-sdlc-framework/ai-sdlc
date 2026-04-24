---
id: AISDLC-38
title: DesignIntentDocument TypeScript Types and Validation Wiring
status: To Do
assignee: []
created_date: '2026-04-24 17:21'
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
- [ ] #1 ResourceKind includes 'DesignIntentDocument'
- [ ] #2 AnyResource includes DesignIntentDocument
- [ ] #3 validateResource(doc) auto-detects kind
- [ ] #4 Schema generation script runs without errors
- [ ] #5 All existing tests pass
<!-- AC:END -->
