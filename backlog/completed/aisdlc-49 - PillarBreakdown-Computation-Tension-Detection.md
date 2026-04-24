---
id: AISDLC-49
title: PillarBreakdown Computation + Tension Detection
status: Done
assignee: []
created_date: '2026-04-24 17:23'
updated_date: '2026-04-24 18:28'
labels:
  - pillar-breakdown
  - admission
  - M3
milestone: m-1
dependencies:
  - AISDLC-48
references:
  - orchestrator/src/admission-score.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create `orchestrator/src/pillar-breakdown.ts` implementing `computePillarBreakdown(priorityInput, scoringIntermediates)` per §A.6.

Dimension-to-pillar attribution (from §A.6 table):
- Product: SA-1, D-pi, M-phi, E-tau, HC_explicit
- Design: SA-2, ER-4, HC_design
- Engineering: ER-1, ER-2, ER-3, C-kappa
- Shared: SA-3, HC_consensus, HC_decision

Emit `PillarContribution` for each (governedDimensions, pillarSignal, interpretation), `SharedDimensions` (sAlpha3 + hcComposite with per-channel breakdown).

`pillarSignalScore()` helper returns aggregate [0,1].

`detectTensions(breakdown)` emits 5 TensionFlag types:
- `PRODUCT_HIGH_DESIGN_LOW` (P > 0.7 AND D < 0.3)
- `PRODUCT_HIGH_ENGINEERING_LOW` (P > 0.7 AND E < 0.3)
- `DESIGN_HIGH_PRODUCT_LOW` (D > 0.7 AND P < 0.3)
- `ENGINEERING_HIGH_PRODUCT_LOW` (E > 0.7 AND P < 0.3)
- `ALL_MEDIUM` (all in [0.3, 0.5])

Mark `pillarBreakdown` REQUIRED (not optional) in `IssueAdmissionResult` type.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every IssueAdmissionResult includes non-null pillarBreakdown
- [x] #2 Golden test: high product + low design → PRODUCT_HIGH_DESIGN_LOW with exact suggestedAction
- [x] #3 Golden test: all-medium scenario → ALL_MEDIUM flag
- [x] #4 hcComposite exposes channel map {explicit, consensus, decision, design}
- [x] #5 interpretation strings per pillar are stable (snapshot test)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Pillar breakdown + tension detection landed. Every `IssueAdmissionResult` now carries a required `pillarBreakdown` with three `PillarContribution`s (product/design/engineering), a `SharedDimensions` section with per-channel HC map, and an array of tension flags drawn from a stable 5-type vocabulary.

## Changes
- `orchestrator/src/pillar-breakdown.ts` (new): `computePillarBreakdown(composite)` attributes dimensions per §A.6 table; `detectTensions(breakdown)` emits the 5 TensionFlag types with stable `suggestedAction` strings; `pillarSignalScore` exported for external callers. Types: `PillarName`, `TensionFlagType`, `PillarContribution`, `HcChannelBreakdown`, `SharedDimensions`, `TensionFlag`, `PillarBreakdown`.
- `orchestrator/src/admission-score.ts`: `IssueAdmissionResult` now has `pillarBreakdown: PillarBreakdown` (required, not optional); both admitted and rejected branches populate it.
- `orchestrator/src/pillar-breakdown.test.ts` (new): 17 tests — `pillarSignalScore` edge cases, pillar attribution, HC channel map (AC #4), interpretation regex snapshot (AC #5), each tension type with exact suggestedAction (AC #2, #3), overlapping flag emission, no-flag balanced cases, required-field presence on admitted + rejected results (AC #1).

## Design decisions
- **SA-1/SA-2/SA-3 split deferred to M5**: current code attributes `soulAlignment` wholesale to Product (as the stand-in for SA-1). When M5 lands, `computePillarBreakdown` reads `composite.breakdown.sa2` for Design and `sa3` for Shared without changing the caller surface.
- **Defect risk mapped to engineering as `1 − 2 × defectRiskFactor`**: `defectRiskFactor ∈ [0, 0.5]` so doubling normalizes it to a [0, 1] quality signal (0.5 penalty → 0 quality).
- **Interpretation strings snapshot-tested via regex**, not exact match: the numeric signal floats, so the test pins the shape (band word + two-decimal signal + fixed suffix) rather than exact string. Stability is what consumers need.
- **`suggestedAction` strings are frozen** in a module-level `SUGGESTED_ACTIONS` record — AC #2 and AC #3 assert exact equality so any drift triggers a test failure.
- **`shared.hcComposite.value`** is the tanh-compressed HC alongside the four signed channel values. Reviewers can see both the raw channels and the composite without recomputing.
- **Overlapping tensions all fire**: e.g. Product high + Design low + Engineering low emits both `PRODUCT_HIGH_DESIGN_LOW` and `PRODUCT_HIGH_ENGINEERING_LOW`. Doesn't try to pick a "most important" one — reviewers see the full disagreement map.
- **ALL_MEDIUM uses strict `[0.3, 0.5]` bounds on all three pillars**: doesn't fire when any pillar breaches either edge (intent is "everything is mid, no signal").

## Verification
- `pnpm build` — clean (all 9 packages)
- `pnpm vitest run src/pillar-breakdown.test.ts` — 17/17 pass
- `pnpm vitest run` (full orchestrator) — 2000/2000 pass (+17 over baseline)
- `pnpm lint` — clean

## Follow-up
AISDLC-50 emits `pillarBreakdown` in the admission CLI JSON output and wires `--enrich-from-state` so the orchestrator feeds real DSB + state context into the composite at production admission time.
<!-- SECTION:FINAL_SUMMARY:END -->
