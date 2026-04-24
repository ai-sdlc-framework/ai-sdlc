---
id: AISDLC-39
title: Config Loader + DID→DSB Cross-Resource Validation
status: Done
assignee: []
created_date: '2026-04-24 17:21'
updated_date: '2026-04-24 20:41'
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
- [x] #1 Loader aggregates multiple DID files into config.designIntentDocuments
- [x] #2 Dangling designSystemRef throws during config load with file path and ref name
- [x] #3 Test covers: valid DID, unresolved ref, DID with missing namespace, two DIDs referencing same DSB
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Config loader extended to collect `DesignIntentDocument` resources as a multi-instance array (mirroring `designSystemBindings`). Cross-resource validation enforces that every DID's `spec.designSystemRef.name` resolves to a loaded `DesignSystemBinding` — namespace-aware when both resources declare one. DSB surface unchanged (DID → DSB is unidirectional per scope decision).

## Changes
- `orchestrator/src/config.ts`: extended `AiSdlcConfig` with `designIntentDocuments?: DesignIntentDocument[]`. Updated `KIND_KEY` to exclude `DesignIntentDocument` from the single-instance kind map. Added loader branch `else if (resource.kind === 'DesignIntentDocument')` that appends to the array. New exported function `validateDesignIntentDocumentReferences(config)` walks DIDs, matches against DSBs (name + optional namespace), collects unresolved refs into a single error message with DID name + target ref.
- `orchestrator/src/config-did.test.ts` (new, 12 tests): multi-instance collection of DIDs into `designIntentDocuments`, two DIDs referencing same DSB both resolve, orphan DID throws with ref name in the error, name-only match when DID omits namespace, name+namespace match when both declare it, namespace mismatch throws, unit tests for `validateDesignIntentDocumentReferences` in isolation (empty config, loaded DSB, nonexistent DSB, name-only match, namespace-mismatch, multiple unresolved refs collected in one error).

## Verification
- `pnpm build` (orchestrator) — clean
- `pnpm vitest run src/config-did.test.ts` — 12/12 pass
- All existing orchestrator tests pass (2256 total)

## Follow-up
Retroactively closed after full RFC-0008 implementation completed (see PR #63).
<!-- SECTION:FINAL_SUMMARY:END -->
