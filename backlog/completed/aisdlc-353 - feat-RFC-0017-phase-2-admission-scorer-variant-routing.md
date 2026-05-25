---
id: AISDLC-353
title: 'feat: RFC-0017 Phase 2 — admission scorer composition (Sα₁ + Sα₂ variant routing) + cross-variant aggregation'
status: To Do
assignee: []
created_date: '2026-05-18'
labels:
  - rfc-0017
  - variant-pattern
  - phase-2
  - admission-scoring
dependencies:
  - AISDLC-352
references:
  - spec/rfcs/RFC-0017-in-soul-variant-pattern.md
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
priority: high
blocked:
  reason: 'RFC-0017 lifecycle is Ready for Review with all 8 §10 OQs RESOLVED (operator walkthrough 2026-05-18). Implementation broken into 5 phase tasks (AISDLC-352..356) per operator decision. RFC-0009 lifecycle is Ready for Review and was the basis for the already-shipped tessellation-admission routing (AISDLC-313). Both RFCs are stable enough to execute Phase 2 against; lifecycle promotion to Signed Off is a separate operator action.'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2 of RFC-0017 §9. Admission scorer routes Sα₁ + Sα₂ scoring through variant-level design intent when work item declares `targetedVariants`.

## Scope

- **Sα₁ variant routing** (`orchestrator/src/admission/variant-sa1-router.ts`): when a work item has `targetedVariants`, Sα₁ Problem Resonance scores against the variant's `audienceCharacteristics` (not soul-aggregate).
- **Sα₂ variant routing**: same pattern for Vibe Coherence — scores against variant's `designOverrides` (voiceRegister, colorPaletteOverlay, densityProfile, or vendor-prefixed adopter extensions per OQ-5).
- **Cross-variant aggregation** (OQ-4): when work item targets multiple variants, aggregate scores per `crossVariantAggregation` config (default `min`; per-Soul override via `variant-config.yaml`).
- **Backward compatibility**: work items without `targetedVariants` score against soul-aggregate (existing behavior preserved).
- Reference: RFC-0008 PPA Triad Integration §5 (variant-scoring inheriting parent-shard SA1; this Phase operationalizes it).
- Unit tests: single-variant routing; multi-variant aggregation with `min` default; per-Soul override to `max`; backward-compat (no `targetedVariants` → soul-aggregate).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Sα₁ scoring routes through variant `audienceCharacteristics` when `targetedVariants` declared
- [x] #2 Sα₂ scoring routes through variant `designOverrides` (including vendor-prefixed adopter extensions per OQ-5)
- [x] #3 Cross-variant aggregation: default `min`; per-Soul `crossVariantAggregation` override respected
- [x] #4 Work items without `targetedVariants` score against soul-aggregate (backward-compat)
- [x] #5 Unit tests: single-variant / multi-variant `min` / multi-variant `max` override / backward-compat
- [x] #6 Integration test: end-to-end admission scoring on a work item targeting one of InternalAdopter's variants produces variant-specific score
<!-- AC:END -->

## Implementation Notes

Phase 1 (AISDLC-352) schema additions for `variants[]` on Soul DID + `targetedVariants[]` on Work Item are not yet shipped. Phase 2 (this PR) implements the variant-scope routing algorithm with in-memory shapes (`VariantOverlay`, `VariantScores`, `VariantConfig`, `WorkItemVariantTargeting`, `VariantContext`) that mirror the RFC-0017 §6.1 schema layout. Phase 1's loader will populate `VariantContext` from on-disk Soul DIDs after AISDLC-352 ships; the contract between loader and router is the type shape exported from `orchestrator/src/variant-admission.ts`.

The router is a sibling of `orchestrator/src/tessellation-admission.ts` (RFC-0009 Phase 2.1 soul-scope routing). Both compose into `admission-composite.ts`: tessellation runs first (picks Soul scope), then variant routing refines to variant scope when the work item declares targeted variants. Backward-compat is preserved: work items without `targetedVariants` (or with an unwired variant context) score against soul-aggregate unchanged.

### Cross-Soul + cross-variant interaction (RFC-0017 §6.2)

When a work item targets variants in multiple Souls, the router aggregates per-Soul first (using each Soul's `crossVariantAggregation` rule) then aggregates across Souls via `min` (matches RFC-0009 §7.2 safety-critical default). `defaultCrossSoulVariantRule()` is exported as the documented hook for a future per-tessellation override of the cross-Soul cross-variant layer.
