---
id: AISDLC-41
title: C1 Computable SA-2 Component Wiring (no LLM)
status: Done
assignee: []
created_date: '2026-04-24 17:22'
updated_date: '2026-04-24 17:44'
labels:
  - sa-scoring
  - c1
  - M1
milestone: m-1
dependencies:
  - AISDLC-38
  - AISDLC-40
references:
  - orchestrator/src/admission-score.ts
  - orchestrator/src/priority.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the v4 §5.2 computable half of SA-2 in `orchestrator/src/sa-scoring/c1-sa2-computable.ts`.

Given a DID + resolved DSB + issue code area, return `{ tokenCompliance: 0.3×, catalogHealth: 0.2×, computableComponent: number }`. LLM component returns `null` — M5 replaces it.

Expose `computeSa2Computable(did, dsb)` and wire into `admission-score.ts` behind flag `c1.enabled`. Label-based `soulAlignment` stays as fallback per §A.5 phase-1 note.

Formula: `computableComponent = 0.3 × tokenCompliance + 0.2 × catalogHealth`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 computeSa2Computable returns 0.3*tc + 0.2*ch when both DSB status fields present
- [x] #2 Returns null when DSB absent — caller falls back to label-based path
- [x] #3 Unit tests: full DSB status, missing fields, DID with no designSystemRef match
- [x] #4 No change to public computePriority signature
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Computable half of C1/SA-2 landed as a pure, side-effect-free module. LLM component deferred to M5 (AISDLC-59/60) per plan.

## Changes
- `orchestrator/src/sa-scoring/c1-sa2-computable.ts`: new module exporting `computeSa2Computable(did, dsb)`. Formula: `0.3 × tokenCompliance + 0.2 × catalogHealth`. Reads normalized coverage from `dsb.status.tokenCompliance.currentCoverage` and `dsb.status.catalogHealth.coveragePercent`. Accepts both percentage (0–100) and ratio (0–1) inputs, clamps to [0, 1], treats NaN/missing as 0. Returns `undefined` when DSB/status absent or neither coverage field present — caller falls back to label-based `soulAlignment` per §A.5.
- `orchestrator/src/sa-scoring/c1-sa2-computable.test.ts`: 11 unit tests covering full DSB status, missing individual fields, unresolved DSB ref, status absent, percentage vs ratio inputs, NaN defense, clamp to [0, 0.5] theoretical max.

## Design decisions
- **Returns `undefined` not `null`** when it can't compute: easier for callers to chain with `??` fallback to label-based path.
- **Accepts DID but doesn't read it yet** (`void did`): API is future-proof for per-principle weighting in §B.6/§B.7 but M1 has no need to consume DID fields.
- **`llmComponent: null` (not `undefined`)**: explicit "computed; value is null" distinguishes this from "missing field". M5 flips this to a number.
- **No admission-score.ts integration yet**: the plan assigns wiring into the admission composite to AISDLC-48 (M3). This task keeps the C1 module pure; no change to `computePriority` signature.

## Verification
- `pnpm build` — clean
- `pnpm vitest run src/sa-scoring` — 11/11 pass
- `pnpm vitest run` (full orchestrator) — 1837/1837 pass
- `pnpm lint` — clean

## Follow-up
- AISDLC-48 wires `computeSa2Computable` into the admission composite (`sa2Blended = computable + w_llm × llm × designConflictPenalty`) behind the `c1.enabled` flag.
- AISDLC-59/60 replace the `null` LLM component with a real Layer 3 structured assessment.
<!-- SECTION:FINAL_SUMMARY:END -->
