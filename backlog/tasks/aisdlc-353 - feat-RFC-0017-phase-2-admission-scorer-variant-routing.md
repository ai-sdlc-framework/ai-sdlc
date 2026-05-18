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
- [ ] #1 Sα₁ scoring routes through variant `audienceCharacteristics` when `targetedVariants` declared
- [ ] #2 Sα₂ scoring routes through variant `designOverrides` (including vendor-prefixed adopter extensions per OQ-5)
- [ ] #3 Cross-variant aggregation: default `min`; per-Soul `crossVariantAggregation` override respected
- [ ] #4 Work items without `targetedVariants` score against soul-aggregate (backward-compat)
- [ ] #5 Unit tests: single-variant / multi-variant `min` / multi-variant `max` override / backward-compat
- [ ] #6 Integration test: end-to-end admission scoring on a work item targeting one of InternalAdopter's variants produces variant-specific score
<!-- AC:END -->
