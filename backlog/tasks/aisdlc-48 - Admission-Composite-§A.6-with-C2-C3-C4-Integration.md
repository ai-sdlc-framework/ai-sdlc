---
id: AISDLC-48
title: Admission Composite §A.6 with C2/C3/C4 Integration
status: Done
assignee: []
created_date: '2026-04-24 17:23'
updated_date: '2026-04-24 18:24'
labels:
  - admission
  - composite
  - M3
milestone: m-1
dependencies:
  - AISDLC-43
  - AISDLC-44
  - AISDLC-45
  - AISDLC-47
references:
  - orchestrator/src/admission-score.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Rewrite `scoreIssueForAdmission` to implement the admission subset per §A.6:

```
composite = SA × D-pi_adjusted × ER × (1 + HC)

where:
  SA = soulAlignmentDim (includes C1 computable when available)
  D-pi_adjusted = rawDemandPressure × (1 - defectRiskFactor)
                  rawDemandPressure = (demand + consensus + conviction + drift) / 4
  ER = min(baseER × autonomyFactor, designSystemReadiness)
       baseER = 1 - complexity/10
```

M-phi, E-tau, C-kappa explicitly deferred to runtime scoring (document in code comment mirroring §A.6 table).

Preserve `override` short-circuit and admission threshold gate. Existing `computePriority` runtime composite preserved for non-admission callers. Backward compatible: existing `mapIssueToPriorityInput` without new fields produces sensible scores.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 All neutral (0.5) inputs reproduce expected composite
- [x] #2 defectRiskFactor=0.5 halves D-pi
- [x] #3 autonomyFactor=0.5 and designSystemReadiness=0.3 → ER = 0.3 (min)
- [x] #4 Override path still returns Infinity
- [x] #5 Backward-compat test: existing callers without new fields produce sensible scores
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
§A.6 admission-subset composite landed. `scoreIssueForAdmission` now computes `SA × D-pi_adjusted × ER × (1 + HC)` with C3 defect-risk adjustment, C4 autonomy factor, and C2 readiness floor — M-phi/E-tau/C-kappa explicitly deferred to runtime. All 37 existing admission tests still pass (backward-compat) plus 12 new composite tests.

## Changes
- `orchestrator/src/admission-composite.ts` (new): `computeAdmissionComposite(input, config?)` returns `{score: PriorityScore, breakdown}` with the admission math laid out term-by-term for auditability. Preserves override position-1 bypass (Infinity). Reports configured `calibrationCoefficient` as `dimensions.calibration` for display continuity but does not multiply into composite.
- `orchestrator/src/admission-score.ts`: `scoreIssueForAdmission` now delegates to `computeAdmissionComposite`; `mapIssueToPriorityInput` and `PriorityInput` export surface unchanged.
- `orchestrator/src/admission-enrichment.ts`: new `computeReadinessFromDesignSystemContext(ctx?)` — state-free helper that applies the §A.5 readiness formula directly to a pre-populated `DesignSystemContext` (no DSB/state lookups on the hot path).
- `orchestrator/src/priority.ts`: exported `computeConfidence` so the admission composite can reuse the existing confidence heuristic.
- `orchestrator/src/admission-composite.test.ts` (new): 12 tests — formula decomposition, neutral-input golden values (AC #1), defect risk halving (AC #2), ER = min (AC #3 both branches), override/veto distinction (AC #4), backward compat (AC #5), calibration display passthrough + clamp, monotonic sensitivity to defect risk + autonomy gap.

## Design decisions
- **`calibration` dimension still reports the config coefficient** even though §A.6 defers C-kappa: existing callers (dashboard, tests) read `score.dimensions.calibration`. Preserving the field shape at neutral or at the configured value keeps the `PriorityScore` contract stable; the composite math just doesn't multiply by it. Clamped to [0.7, 1.3] per PPA §6.
- **`complexity` defaults to 5 (midpoint) when unspecified** rather than extending `DEFAULT_SIGNAL=0.5`. `complexity` is a raw score in [0, 10], not a signal in [0, 1] — defaulting to 5 yields a neutral baseER of 0.5, which is what a "we don't know" signal should produce.
- **`competitiveDrift` enters rawDP, not entropy tax**: §A.6 table is explicit — drift is a *demand* signal (the market is slipping away, so act) at admission time, whereas E-tau is the *runtime* decay penalty (entropy grows while work sits unfinished). They're distinct concerns that happened to share a name earlier.
- **`mapIssueToPriorityInput` called inside the composite**: keeps one source of truth for how AdmissionInput maps to PPA dimensions. Eventual M5 SA-1/SA-2 replacement swaps just the `soulAlignment` line without rewiring everything.
- **`override` preserved as short-circuit branch**: position-1 bypass sits above all §A.6 math. Returns `Infinity` with full-score dimensions — callers that ranked items by composite still see override items sort first.

## Verification
- `pnpm build` — clean (all 9 packages)
- `pnpm vitest run src/admission-composite.test.ts` — 12/12 pass
- `pnpm vitest run src/admission-score.test.ts` — 37/37 pass (backward compat)
- `pnpm vitest run` (full orchestrator) — 1983/1983 pass (+12 over baseline)
- `pnpm lint` — clean

## Follow-up
- AISDLC-49 wires `pillarBreakdown` onto `IssueAdmissionResult` using the breakdown returned here.
- AISDLC-50 threads the `--enrich-from-state` flag through the CLI and GitHub Actions workflow so the composite actually sees populated `designSystemContext`, `autonomyContext`, etc. in production.
<!-- SECTION:FINAL_SUMMARY:END -->
