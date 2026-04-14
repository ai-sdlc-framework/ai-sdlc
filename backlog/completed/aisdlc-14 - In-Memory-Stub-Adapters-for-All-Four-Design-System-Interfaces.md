---
id: AISDLC-14
title: In-Memory Stub Adapters for All Four Design System Interfaces
status: Done
assignee: []
created_date: '2026-04-13 22:54'
updated_date: '2026-04-13 23:18'
labels:
  - adapter
  - stub
  - testing
  - M2
milestone: m-0
dependencies:
  - AISDLC-12
  - AISDLC-13
references:
  - reference/src/adapters/stubs/jira.ts
  - reference/src/adapters/stubs/index.ts
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create four in-memory stub adapter implementations following the existing stub pattern (createStub<Name>(): Stub<Name>Adapter).

Stubs:
1. createStubDesignTokenProvider — preloadable tokens, records diffs, simulates subscriptions
2. createStubComponentCatalog — preloadable manifest, returns canned matches
3. createStubVisualRegressionRunner — configurable diff percentages, generates structured failure payloads
4. createStubUsabilitySimulationRunner — configurable completion rates, generates simulation results with action traces

Each stub stores state in-memory with test helper methods for inspection (e.g., getTokenSyncCount(), getSimulationCount()). Each stub must have a corresponding test file. Export all stubs from reference/src/adapters/stubs/index.ts and reference/src/adapters/index.ts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Four stub files created in reference/src/adapters/stubs/
- [x] #2 Each stub implements the full interface (no not-implemented throws)
- [x] #3 Each stub has test helper methods for inspection
- [x] #4 Test file for each stub validating happy path and error cases
- [x] #5 All stubs exported from barrel index files
<!-- AC:END -->
