---
id: AISDLC-44
title: C3 Defect Risk Factor with hasFrontendComponents Blend
status: Done
assignee: []
created_date: '2026-04-24 17:22'
updated_date: '2026-04-24 17:56'
labels:
  - enrichment
  - c3
  - M2
milestone: m-1
dependencies:
  - AISDLC-42
  - AISDLC-40
references:
  - orchestrator/src/admission-enrichment.ts
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Extend `enrichAdmissionInput` to populate `codeAreaQuality` from `stateStore.getCodeAreaMetrics(codeArea, {window:'90d'})`. Require `metrics.dataPointCount >= 10`.

Create `orchestrator/src/code-area-classifier.ts` with `checkHasFrontendComponents(codeArea, stateStore)`. Heuristic on code path (`components/`, `ui/`, `*.tsx`, `*.vue`) plus catalog provider lookup.

Extend `mapIssueToPriorityInput` with `defectRiskFactor` per §A.5:
- **!hasFrontendComponents**: `defectRisk = 0.5*dd + 0.3*churn + 0.2*prRej`
- **hasFrontendComponents + designQuality**: blend `0.7×code + 0.3×design` where `design = 0.4*(1-ciPass) + 0.4*reviewRej + 0.2*(1-usabPass)`
- Clamp result to [0, 0.5]

Default to 0.0 if `dataPointCount < 10` (per §7.4 Open Question 4 resolution).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Pure code path when hasFrontendComponents=false ignores designQuality
- [x] #2 Blended path applied only when hasFrontendComponents=true AND designQuality present
- [x] #3 Clamp ceiling at 0.5
- [x] #4 defectRiskFactor = 0.0 when dataPointCount < 10
- [x] #5 Table-driven tests cover all 4 permutations
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
C3 defect-risk factor wired in. Code area classifier distinguishes frontend-bearing paths; enrichment populates `codeAreaQuality` only when state has ≥10 data points; pure compute helper applies the pure-code or frontend-blended formula, clamped to [0, 0.5].

## Changes
- `orchestrator/src/code-area-classifier.ts` (new): `checkHasFrontendComponents(codeArea, store?)` — trusts state-store classification, falls back to path heuristic (`components/`, `ui/`, `pages/`, `.tsx`, `.vue`, etc.); `matchesFrontendHeuristic` exported for reuse in tests.
- `orchestrator/src/admission-enrichment.ts`: added `codeArea` to `EnrichmentContext`; `buildCodeAreaQuality()` reads 90d window, filters on `dataPointCount ≥ CODE_AREA_METRICS_MIN_DATA_POINTS` (=10), parses `design_metrics_json` into `designQuality`; `computeDefectRiskFactor()` exported. `enrichAdmissionInput` now attaches `codeAreaQuality` alongside `designSystemContext`.
- `orchestrator/src/code-area-classifier.test.ts` (new): 15 tests — heuristic table + state-store override semantics.
- `orchestrator/src/admission-enrichment.test.ts`: +12 tests covering the 4×permutation table (AC #5), clamping floor/ceiling, data-point gate, heuristic fallback.

## Design decisions
- **`codeAreaQuality` absent ⇒ `defectRiskFactor = 0`**: keeps downstream composite simple — no "is the data trustworthy" check at the consumer site. Gate lives in enrichment.
- **State-store classification wins over heuristic**: `components/admin/ServerAction.ts` can be marked non-frontend by an operator writing `hasFrontendComponents = false` on the metrics row. Tested both directions.
- **Design-quality metrics stored as JSON blob** (`design_metrics_json` column): the three signals (`designCIPassRate`, `designReviewRejectionRate`, `usabilitySimPassRate`) each have distinct ingestion paths; serializing as JSON lets us add signals without a migration.
- **Pure-code formula used even when `hasFrontendComponents=true` if no `designQuality`**: the blend needs a real design signal. Treating missing design signals as 0 would falsely reward frontend areas by halving their code-quality penalty.
- **Clamp on final blend, not per-term**: §A.5 is explicit that only the output is clamped to [0, 0.5].

## Verification
- `pnpm build` — clean
- `pnpm vitest run src/code-area-classifier.test.ts src/admission-enrichment.test.ts` — 48/48 pass
- `pnpm vitest run` (full orchestrator) — 1892/1892 pass (+27 over baseline)
- `pnpm lint` — clean

## Follow-up
- AISDLC-45 populates `autonomyContext` (C4)
- AISDLC-46 populates `designAuthoritySignal` (C5)
- AISDLC-48 multiplies `D-pi_raw × (1 - defectRiskFactor)` into the admission composite.
<!-- SECTION:FINAL_SUMMARY:END -->
