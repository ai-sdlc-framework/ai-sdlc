---
id: AISDLC-9
title: DesignSystemBinding JSON Schema
status: Done
assignee: []
created_date: '2026-04-13 22:53'
updated_date: '2026-04-13 23:18'
labels:
  - schema
  - foundation
  - M1
milestone: m-0
dependencies: []
references:
  - spec/rfcs/RFC-0006-design-system-governance-v5-final.md
  - spec/schemas/adapter-binding.schema.json
  - spec/schemas/common.schema.json
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create `spec/schemas/design-system-binding.schema.json` with the full DesignSystemBinding resource schema from RFC-0006 Section 5.

Key spec fields: stewardship (designAuthority, engineeringAuthority, sharedAuthority, changeApproval), designToolAuthority enum (exploration|specification|collaborative), tokens (provider, format, source, versionPolicy, pinnedVersion, sync, platform), catalog (provider, source, discovery), visualRegression (provider, config), compliance (disallowHardcoded array, coverage), designReview (required, reviewers, scope, triggerConditions), extends (string ref for multi-brand inheritance).

Status subschema: lastTokenSync, catalogHealth, tokenCompliance, designReview, conditions array.

Conditional requirements via if/then: pinnedVersion required when versionPolicy=exact, manualResolutionTimeout required when conflictResolution=manual.

Pattern to follow: `spec/schemas/adapter-binding.schema.json` — uses `common.schema.json#/$defs/apiVersion` and `#/$defs/metadata`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Schema validates the full worked example from RFC-0006 Section 5
- [x] #2 versionPolicy enum includes exact, minor, minor-and-major, latest
- [x] #3 pinnedVersion conditionally required when versionPolicy=exact (if/then)
- [x] #4 manualResolutionTimeout conditionally required when conflictResolution=manual
- [x] #5 extends field accepts string reference to another binding name
- [x] #6 designToolAuthority enum: exploration, specification, collaborative
- [x] #7 Schema passes ajv compilation with draft 2020-12
<!-- AC:END -->
