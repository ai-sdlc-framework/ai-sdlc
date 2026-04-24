---
id: AISDLC-46
title: C5 Design Authority Signal + HC_design Channel Detection
status: Done
assignee: []
created_date: '2026-04-24 17:22'
updated_date: '2026-04-24 18:02'
labels:
  - enrichment
  - c5
  - design-authority
  - M2
milestone: m-1
dependencies:
  - AISDLC-42
references:
  - orchestrator/src/admission-enrichment.ts
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create `orchestrator/src/design-authority.ts` implementing `checkDesignAuthority(input, principals)`.

Match issue author or commenter GitHub handles against `DesignSystemBinding.spec.stewardship.designAuthority.principals`. Populate `designAuthoritySignal` on enriched input.

Signal types parsed from issue labels (`design/advances-coherence`, `design/fragments-catalog`, `design/misaligned-brand`, `design/fills-gap`) or structured comment body markers.

In `mapIssueToPriorityInput`, compute `designAuthorityWeight` per §A.5:
- `advances-design-coherence|fills-catalog-gap` → +0.6
- `fragments-component-catalog|misaligned-with-brand` → -0.4
- Design authority with no explicit signal type → baseline +0.3
- Modulate by `(1.2 - areaComplianceScore)` when present

Non-authority author → weight = 0.0.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Non-authority author → designAuthorityWeight = 0.0
- [x] #2 Authority with advances-design-coherence and areaComplianceScore=0.9 → 0.6 * (1.2 - 0.9) = 0.18
- [x] #3 Authority with no typed signal → 0.3
- [x] #4 Unit tests for all four signal types + compliance modulation
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
C5 design-authority signal landed — the last M2 task. Enrichment now populates all four RFC-0008 context fields (C2/C3/C4/C5) and exposes a compute helper for each factor.

## Changes
- `orchestrator/src/design-authority.ts` (new): `checkDesignAuthority()` matches author + commenter handles against `DesignSystemBinding.spec.stewardship.designAuthority.principals` (case-insensitive); `parseDesignSignalType()` extracts the typed signal from labels (`design/advances-coherence`, `design/fills-gap`, `design/fragments-catalog`, `design/misaligned-brand`) with positive-signals-win priority order.
- `orchestrator/src/admission-score.ts`: added optional `authorLogin` and `commenterLogins` to `AdmissionInput` (backward-compatible — existing callers don't need them).
- `orchestrator/src/admission-enrichment.ts`: added `areaComplianceScore` to `EnrichmentContext`; new private `buildDesignAuthoritySignal()`; exported `computeDesignAuthorityWeight()` with base weights `{advances|fills: +0.6, fragments|misaligned: -0.4, unspecified: +0.3}` and compliance modulation `(1.2 − areaComplianceScore)` when present, unmodulated otherwise.
- `orchestrator/src/design-authority.test.ts` (new): 14 tests — label parsing table, principal matching via author + commenters, case-insensitivity, positive-signal tiebreaker.
- `orchestrator/src/admission-enrichment.test.ts`: +14 tests covering all 4 signal types × modulation, the AC #2 golden value (0.18), non-authority = 0, and end-to-end enrichment with commenter-only authority.

## Design decisions
- **Positive signals win when both are labeled**: if a design authority simultaneously tagged `design/fragments-catalog` and `design/advances-coherence`, we pick the positive. Intentional — prevents a mis-tagged positive intent from eating a punitive weight, and authorities shouldn't dual-tag in practice.
- **Case-insensitive matching on both labels and principals**: GitHub handles are canonical lowercase but often displayed in mixed case; labels may drift in casing across plugins.
- **`commenterLogins` separated from `authorLogin`**: the RFC treats authority signals identically whether they come from the author or a commenter (§A.5). Keeping them separate on the API lets future heuristics weight them differently without another schema change.
- **`areaComplianceScore` lives on `EnrichmentContext`, not `DesignAuthoritySignal`**: it's a property of the code area, not the signal itself. Threading it through the context keeps the shape clean. It surfaces on the signal in the final output for downstream auditability.
- **`signalType: 'unspecified'` for authority-without-label**: makes the base-weight table total — no `undefined` branches in `computeDesignAuthorityWeight`.

## Verification
- `pnpm build` — clean
- `pnpm vitest run src/design-authority.test.ts src/admission-enrichment.test.ts` — 87/87 pass
- `pnpm vitest run` (full orchestrator) — 1946/1946 pass (+28 over baseline)
- `pnpm lint` — clean

## Follow-up
All of M2 (AISDLC-42–46) is now done. M3 (AISDLC-47–50) wires these four compute helpers (`computeDesignSystemReadiness`, `computeDefectRiskFactor`, `computeAutonomyFactor`, `computeDesignAuthorityWeight`) into the admission composite per §A.6.
<!-- SECTION:FINAL_SUMMARY:END -->
