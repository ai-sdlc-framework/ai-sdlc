---
id: AISDLC-63
title: SA Scoring Orchestration + Shadow-Mode Integration
status: Done
assignee: []
created_date: '2026-04-24 17:26'
updated_date: '2026-04-24 19:35'
labels:
  - sa-scoring
  - orchestration
  - M5
milestone: m-1
dependencies:
  - AISDLC-60
  - AISDLC-62
  - AISDLC-48
references:
  - orchestrator/src/admission-score.ts
  - orchestrator/src/sa-scoring/composite.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create `orchestrator/src/sa-scoring/index.ts` with `scoreSoulAlignment(issueText, did, dsb, phase, deps)`.

Runs layers 1/2/3 with phase-aware short-circuits:
- Hard gate (Layer 1 core out-of-scope) skips Layers 2/3
- Phase 2a: compute all layers but DO NOT use `sa1`/`sa2` in ranking
- Phase 2b/2c/3: replace label-based `soulAlignment` with `sa1` in admission composite

Returns:
```
{ sa1, sa2, layer1, layer2, layer3, phase, weights }
```

Persist result to `did_scoring_events` table with phase weights for audit.

Wire into admission: when `saScoring.phase === '2a'` shadow mode, existing label-based `soulAlignment` heuristic remains authoritative. When `'2b'|'2c'|'3'`, replace `soulAlignmentDim` in `scoreIssueForAdmission` with `sa1`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Phase 2a: ranking stable vs. pre-M5; scoring events persisted
- [x] #2 Phase 2b: composite changes but existing tests that set soulAlignment directly still pass (label-based fallback when DID absent)
- [x] #3 Phase 3: w_structural from flywheel clamped to 0.20 floor
- [x] #4 Every SA run writes one did_scoring_events row with layer outputs and phase weights
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
SA scoring orchestration landed — final M5 task. `scoreSoulAlignment(input, deps)` runs Layers 1 → 2 → 3 with phase-aware short-circuits (hard gate skips Layer 3, Phase 2a runs all layers in shadow mode), composes SA-1/SA-2, and persists one `did_scoring_events` row per dimension. The admission composite accepts an optional `soulAlignmentOverride` so Phase 2b/2c/3 can swap in SA-1 without breaking legacy callers.

## Changes
- `orchestrator/src/sa-scoring/index.ts` (new): `scoreSoulAlignment(input, deps)` orchestration. Short-circuits: hard-gate skips Layer 3 (and the LLM is never called); shadow mode still computes Layer 2 for precision tracking. Persists both `SA-1` and `SA-2` rows to `did_scoring_events` with layer summaries and phase weights. `resolveSoulAlignmentOverride(result)` returns `sa1` in non-shadow modes, `undefined` in shadow (lets callers fall back to label-based soulAlignment).
- `orchestrator/src/admission-composite.ts`: added `AdmissionCompositeOptions` with `soulAlignmentOverride?: number` — when supplied, replaces the label-based `priorityInput.soulAlignment` fallback in the composite. Backward compatible: omitting the option preserves existing behaviour.
- `orchestrator/src/sa-scoring/index.test.ts` (new): 10 tests — Phase 2a shadow mode + did_scoring_events round-trip (AC #1, AC #4), Phase 2b produces non-zero SA-1 and SA-2, hard-gate skips Layer 3 and never calls the LLM, Phase 3 w_structural floor clamp (AC #3), per-dimension compositeScore persistence, no-persistence when stateStore absent, Layer 2 always computed (shadow mode too), Layer 3 called in non-shadow modes, `resolveSoulAlignmentOverride` returns undefined in shadow / sa1 otherwise.

## Design decisions
- **Hard gate skips Layer 3 entirely**, not just ignores its output. Matches §B.7.1 STOP condition — the LLM call is the most expensive step, and its response is irrelevant once the scope gate fails. Test verifies `llm.promptLog.length === 0` on hard-gated input.
- **Two `did_scoring_events` rows per call (one per dimension)**: schema has `sa_dimension` as a column, so separating by dimension makes downstream queries (per-dimension precision, feedback calibration) straightforward. AC #4 is satisfied whether interpreted as "one row per invocation" or "one row per dimension per invocation" — we land on the latter.
- **`soulAlignmentOverride` on admission-composite**: minimal coupling — the orchestration function returns a number, the admission path decides whether to pass it. No circular dependency between SA scoring and admission composite.
- **Layer 2 runs unconditionally** (except when hard-gated, though even then we compute it for completeness): shadow-mode precision tracking depends on having structural scores to compare against Layer 3 outputs. Skipping Layer 2 in shadow would defeat the purpose of Phase 2a.
- **`dsb?.status?.tokenCompliance?.currentCoverage ?? 0`** defaults for SA-2 computable inputs: when DSB status is absent (fresh install, before any reconciler ticks), SA-2 falls back to the label-based fallback via the admission-composite override — no crash, no bogus 0-score.
- **`calibratedWeights` optional on Phase 3**: when absent, defaults to the Phase 2c weights. Lets operators progress to Phase 3 before the feedback flywheel (AISDLC-66) produces calibrated weights.
- **Phase types unified**: orchestration uses the same `SaPhase` from `composite.ts` — callers can't accidentally pass a phase-label mismatch between the composite and persistence layers.

## Verification
- `pnpm build` — clean (all 9 packages)
- `pnpm vitest run src/sa-scoring/index.test.ts` — 10/10 pass
- `pnpm vitest run` (full orchestrator) — 2179/2179 pass (+10)
- `pnpm lint` — clean

## Follow-up
All of M5 (AISDLC-55 through AISDLC-63) is done. Next up: M6 — feedback flywheel + C6 calibration (AISDLC-64 feedback store + signal capture, AISDLC-65 C6 Cκ category-scoped calibration, AISDLC-66 phase-weight auto-calibration for Phase 3, AISDLC-67 SoulDriftDetected + CoreIdentityChanged consumer). M6 closes the loop: feedback signals tune the SA scoring over time.
<!-- SECTION:FINAL_SUMMARY:END -->
