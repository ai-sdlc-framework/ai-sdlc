---
id: AISDLC-10
title: DesignSystemBinding TypeScript Types and Validation Wiring
status: Done
assignee: []
created_date: '2026-04-13 22:53'
updated_date: '2026-04-13 23:18'
labels:
  - types
  - foundation
  - M1
milestone: m-0
dependencies:
  - AISDLC-9
references:
  - reference/src/core/types.ts
  - reference/src/core/validation.ts
  - spec/schemas/adapter-binding.schema.json
  - reference/scripts/generate-schemas.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add the DesignSystemBinding resource type to the TypeScript type system and wire into validation.

1. Add 'DesignSystemBinding' to ResourceKind union (reference/src/core/types.ts:12)
2. Define interfaces: DesignSystemBindingSpec, Stewardship, TokenConfig, CatalogConfig, VisualRegressionConfig, ComplianceConfig, DesignReviewConfig, DesignSystemBindingStatus
3. Create type alias: DesignSystemBinding = Resource<'DesignSystemBinding', DesignSystemBindingSpec, DesignSystemBindingStatus>
4. Add to AnyResource union (types.ts:638)
5. Add to SCHEMA_FILES map (reference/src/core/validation.ts:27)
6. Add DesignTokenProvider, ComponentCatalog, VisualRegressionRunner, UsabilitySimulationRunner to AdapterInterface union
7. Update adapter-binding.schema.json interface enum
8. Run reference/scripts/generate-schemas.ts
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 ResourceKind includes 'DesignSystemBinding'
- [x] #2 AnyResource includes DesignSystemBinding
- [x] #3 validate('DesignSystemBinding', doc) correctly validates against JSON Schema
- [x] #4 validateResource(doc) auto-detects kind: DesignSystemBinding
- [x] #5 Schema generation script runs without errors
- [x] #6 AdapterInterface union includes DesignTokenProvider, ComponentCatalog, VisualRegressionRunner, UsabilitySimulationRunner
- [x] #7 All existing tests pass
<!-- AC:END -->
