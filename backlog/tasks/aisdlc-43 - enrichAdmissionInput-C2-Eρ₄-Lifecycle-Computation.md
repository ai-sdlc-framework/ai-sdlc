---
id: AISDLC-43
title: enrichAdmissionInput() + C2 Eρ₄ Lifecycle Computation
status: Done
assignee: []
created_date: '2026-04-24 17:22'
updated_date: '2026-04-24 17:52'
labels:
  - enrichment
  - c2
  - M2
milestone: m-1
dependencies:
  - AISDLC-42
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create `orchestrator/src/admission-enrichment.ts` with `enrichAdmissionInput(input, ctx)` bridging stateless scorer and stateful orchestrator (§A.2-A.4).

Implement C2 (Eρ₄) only in this issue. Lifecycle phase detection:
- **preDesignSystem**: no DSB → context undefined, Eρ₄ = 1.0 (no penalty)
- **catalogBootstrap**: `coverage < 20% AND age < 90d` → floor at 0.3
- **postDesignSystem**: fully computed from formula

Formula per §A.5: `computed = 0.4 × catalogCoverage + 0.3 × tokenCompliance + 0.3 × baselineCoverage`

Helpers:
- `computeDsbAgeDays(creationTimestamp)`
- `computeBaselineCoverage(stateStore, input)` — reads `visual_regression_results`
- `identifyCatalogGaps(dsb, input)` — from catalog provider adapter
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Eρ₄ = 1.0 when no DSB in ctx
- [x] #2 catalogBootstrap floor = 0.3 when computed < 0.3 and binding age < 90d and coverage < 20%
- [x] #3 postDesignSystem = 0.4*cat + 0.3*tok + 0.3*baseline exactly
- [x] #4 Golden-value tests for all three lifecycle phases
- [x] #5 baselineCoverage returns 0 when no visual baselines exist
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Admission enrichment bridge landed. C2 Eρ₄ reads the resolved DSB, detects the lifecycle phase, and produces a readiness scalar in [0, 1]. No stateless path regressed — `enrichAdmissionInput()` leaves the input unchanged when no DSB is present.

## Changes
- `orchestrator/src/admission-enrichment.ts` (new): exports `enrichAdmissionInput()`, `computeDesignSystemReadiness()`, `detectLifecyclePhase()`, `computeDsbAgeDays()`, `computeBaselineCoverage()`, `EnrichmentContext`, `LifecyclePhase`.
- `orchestrator/src/admission-enrichment.test.ts` (new): 21 tests — helper unit tests, golden values for all three lifecycle phases, bootstrap-floor coverage, enrichment preserves non-RFC-0008 fields.

## Design decisions
- **`dsbAdoptedAt` supplied by caller** rather than derived from DSB metadata. Kubernetes-style `metadata.creationTimestamp` isn't on the DSB schema; adding it is a separate RFC. Callers (the resource loader) hold the manifest mtime.
- **`computeBaselineCoverage = approved / total`** proxy from `visual_regression_results`. "Fraction of UI under visual-regression monitoring" is the closest deterministic proxy for the RFC's "baseline coverage" without a dedicated pre/post-adoption marker. Returns 0 on empty history (bootstrap-friendly).
- **Clock injection via `ctx.now`**: lets tests freeze time without mocking Date.now globally. Defaults to `Date.now`.
- **No automatic catalog-gap detection yet**: the task description mentions `identifyCatalogGaps(dsb, input)` from a catalog-provider adapter, but adapter integration is deferred. Current API accepts a pre-computed `catalogGaps: string[]` on the context, so callers can feed in adapter output once it lands. Empty array on absence.
- **`computeDesignSystemReadiness` separate from `enrichAdmissionInput`**: the former returns the scalar consumed by the admission composite (AISDLC-48); the latter populates the input's context for auditability. Separating them avoids committing AdmissionInput to storing Eρ₄ directly — it's a derived value.

## Verification
- `pnpm build` — clean
- `pnpm vitest run src/admission-enrichment.test.ts` — 21/21 pass
- `pnpm vitest run` (full orchestrator) — 1865/1865 pass (+28 over baseline)
- `pnpm lint` — clean

## Follow-up
- AISDLC-44 populates `codeAreaQuality` (C3)
- AISDLC-45 populates `autonomyContext` (C4)
- AISDLC-46 populates `designAuthoritySignal` (C5)
- AISDLC-48 consumes `computeDesignSystemReadiness()` in the admission composite: `ER = min(base × autonomyFactor, designSystemReadiness)`.
<!-- SECTION:FINAL_SUMMARY:END -->
