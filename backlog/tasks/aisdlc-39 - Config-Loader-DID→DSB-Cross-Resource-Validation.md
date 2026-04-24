---
id: AISDLC-39
title: Config Loader + DID→DSB Cross-Resource Validation
status: To Do
assignee: []
created_date: '2026-04-24 17:21'
labels:
  - config
  - foundation
  - M1
milestone: m-1
dependencies:
  - AISDLC-38
references:
  - orchestrator/src/config.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Extend `orchestrator/src/config.ts` to collect DID resources as a multi-instance array (same pattern as `designSystemBindings` at config.ts:87). Add `designIntentDocuments?: DesignIntentDocument[]` to `AiSdlcConfig`.

Cross-resource validation: every DID's `spec.designSystemRef.name` must resolve to a loaded DesignSystemBinding (name match; namespace match when both provided). Per user scope decision: DID → DSB is unidirectional; do NOT modify DSB surface.

Emit clear validation error listing unresolved refs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Loader aggregates multiple DID files into config.designIntentDocuments
- [ ] #2 Dangling designSystemRef throws during config load with file path and ref name
- [ ] #3 Test covers: valid DID, unresolved ref, DID with missing namespace, two DIDs referencing same DSB
<!-- AC:END -->
