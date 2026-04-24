---
id: AISDLC-42
title: AdmissionInput & PriorityInput Type Extensions
status: Done
assignee: []
created_date: '2026-04-24 17:22'
updated_date: '2026-04-24 17:49'
labels:
  - types
  - enrichment
  - M2
milestone: m-1
dependencies:
  - AISDLC-38
references:
  - orchestrator/src/admission-score.ts
  - reference/src/core/types.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Extend `AdmissionInput` in `orchestrator/src/admission-score.ts` with new optional fields (Addendum A §A.2):
- `designSystemContext` (catalogCoverage, tokenCompliance, inBootstrapPhase, baselineCoverage, catalogGaps)
- `autonomyContext` (currentEarnedLevel, requiredLevel)
- `codeAreaQuality` (defectDensity, churnRate, prRejectionRate, hasFrontendComponents, designQuality?.{designCIPassRate, designReviewRejectionRate, usabilitySimPassRate})
- `designAuthoritySignal` (isDesignAuthority, signalType, areaComplianceScore)

Extend `PriorityInput` in `reference/src/core/types.ts` (§A.3):
- `designSystemReadiness: number` (Eρ₄, 0.0-1.0)
- `autonomyFactor: number` (0.1-1.0)
- `defectRiskFactor: number` (0.0-0.5 clamped)
- `designAuthorityWeight: number` (-1.0 to 1.0)

Keep all new fields optional for backward compatibility.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 New fields added, no existing field removed
- [x] #2 Type tests verify backward compatibility (existing callers still compile)
- [x] #3 PriorityInput.designSystemReadiness type permits 0.0-1.0
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
AdmissionInput and PriorityInput extended with the full RFC-0008 context surface. All new fields are optional — existing callers compile and score unchanged.

## Changes
- `reference/src/core/types.ts`: added 4 optional numeric fields to `PriorityInput` — `designSystemReadiness` (Eρ₄), `autonomyFactor`, `defectRiskFactor`, `designAuthorityWeight` (each with its range documented inline).
- `orchestrator/src/admission-score.ts`: added 4 optional context fields to `AdmissionInput` — `designSystemContext`, `autonomyContext`, `codeAreaQuality`, `designAuthoritySignal`. Also introduced supporting types: `DesignSystemContext`, `AutonomyContext`, `CodeAreaQuality` (with `hasFrontendComponents` required + optional `designQuality`), `DesignQualityMetrics`, `DesignAuthoritySignal`, `DesignAuthoritySignalType` (literal union).
- `orchestrator/src/admission-score-rfc8-types.test.ts`: 7 tests locking in backward compatibility — legacy shape still compiles, new fields accepted, `mapIssueToPriorityInput` unchanged, `scoreIssueForAdmission` tolerates (ignores) enrichment fields in Phase 1.

## Design decisions
- **`hasFrontendComponents` is required on `CodeAreaQuality`**, everything else optional. It's the branch predicate for the C3 code-vs-design blend (§A.5); making it optional would leak undefined through the blend.
- **`DesignAuthoritySignalType` includes `'unspecified'`** so call sites can represent "designAuthority commented without typed signal" (weight 0.3 per §A.5) without a separate boolean.
- **No field removed from either type** — the four new `PriorityInput` entries sit alongside existing dimensions; `computePriority` will start consuming them in AISDLC-48 (M3).
- **`mapIssueToPriorityInput` unchanged**: AISDLC-43 introduces a separate `enrichAdmissionInput()` for the stateful bridge path; the stateless mapping stays pure.

## Verification
- `pnpm build` (all 9 packages) — clean
- `pnpm vitest run src/admission-score-rfc8-types.test.ts` — 7/7 pass
- `pnpm test` (full workspace) — 2959/2962 pass (3 pre-existing skips, no regressions)
- `pnpm lint` — clean
<!-- SECTION:FINAL_SUMMARY:END -->
