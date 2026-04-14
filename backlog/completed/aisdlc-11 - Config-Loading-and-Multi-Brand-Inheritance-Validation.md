---
id: AISDLC-11
title: Config Loading and Multi-Brand Inheritance Validation
status: Done
assignee: []
created_date: '2026-04-13 22:53'
updated_date: '2026-04-13 23:18'
labels:
  - config
  - foundation
  - M1
milestone: m-0
dependencies:
  - AISDLC-10
references:
  - orchestrator/src/config.ts
  - spec/rfcs/RFC-0006-design-system-governance-v5-final.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Wire DesignSystemBinding into the orchestrator config loader and implement multi-brand inheritance validation.

Config loading: Add designSystemBindings?: DesignSystemBinding[] to AiSdlcConfig. Use array collection pattern (like AdapterBinding). In loadConfig(), accumulate DesignSystemBinding resources into the array.

Inheritance validation: When a child binding references extends, resolve the parent and validate:
- Child compliance thresholds >= parent thresholds
- Child does not remove parent disallowHardcoded categories
- Two-level depth limit (parent → child only, no grandchild)

Create dedicated validateDesignSystemInheritance(child, parent) function.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Config loader collects DesignSystemBinding resources into designSystemBindings array
- [x] #2 Loading two bindings where one extends the other succeeds
- [x] #3 Validation rejects child that loosens parent compliance thresholds
- [x] #4 Validation rejects child that removes parent disallowHardcoded categories
- [x] #5 Validation rejects three-level inheritance chains
- [x] #6 Unit tests for all inheritance validation paths
<!-- AC:END -->
