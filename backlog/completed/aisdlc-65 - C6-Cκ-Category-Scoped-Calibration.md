---
id: AISDLC-65
title: C6 Cκ Category-Scoped Calibration
status: Done
assignee: []
created_date: '2026-04-24 17:27'
updated_date: '2026-04-24 19:45'
labels:
  - c6
  - calibration
  - M6
milestone: m-1
dependencies:
  - AISDLC-64
references:
  - orchestrator/src/priority.ts
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
§10 C6. Replace PPA v1.0's scalar `calibrationCoefficient` with category-scoped calibration.

Create `orchestrator/src/calibration.ts` — `computeCalibrationCoefficient(category, feedback)`:
```
Cκ_category = clamp([0.7, 1.3], 1.0 + (accepts - escalates) / max(1, total) × 0.3)
```

Categories are `PillarContribution.label` values or explicit label-derived categories.

Wire into `computePriority` via optional `categoryResolver(input) -> string` that selects the appropriate coefficient. Backward compatible: absent `categoryResolver` uses scalar.

Per §10 Amendment 6 clarification: this adjusts Cκ global multiplier with category weighting, NOT SA-2 directly. Per-dimension calibration coefficients are PPA v1.1 (§17 v1.1-2).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Scalar path unchanged when no categoryResolver provided
- [x] #2 Category with 10 accepts + 2 escalates → Cκ ≈ 1.0 + (8/12)*0.3 = 1.2
- [x] #3 Clamp to [0.7, 1.3]
- [x] #4 Tests cover: no feedback → 1.0 (neutral); all escalates → 0.7 floor; all accepts → 1.3 ceiling
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
C6 Cκ category-scoped calibration landed. `computeCalibrationCoefficient(feedback)` implements the §10 formula `clamp([0.7, 1.3], 1.0 + (accepts - escalates) / max(1, total) × 0.3)`; `buildCategoryCoefficients(feedback)` aggregates `did_feedback_events` into a per-category table. `computePriority` consumes the table via `categoryResolver` + `categoryCoefficients` on `PriorityConfig` — scalar path preserved when the resolver is absent.

## Changes
- `reference/src/core/types.ts`: extended `PriorityConfig` with optional `categoryResolver?: (input) => string | undefined` and `categoryCoefficients?: Record<string, number>`. Backward compat — existing callers continue to use `calibrationCoefficient`.
- `orchestrator/src/priority.ts`: `computeCalibration(input, config)` (now takes the priority input) looks up `categoryCoefficients[resolver(input)]` when both are present; falls back to scalar otherwise. Returns the clamped coefficient in both paths.
- `orchestrator/src/calibration.ts` (new): `CategoryFeedback` shape, `computeCalibrationCoefficient` pure formula, `buildCategoryCoefficients(feedback, opts)` aggregator that reads `did_feedback_events` via `SAFeedbackStore.list()`, buckets by `category`, skips override signals in the accept/escalate math (they contribute to total via an ignored `overrides` counter only), optional `minSampleSize` / `categories` / `since` / `dimension` filters.
- `orchestrator/src/calibration.test.ts` (new): 16 tests — neutral 1.0 with no feedback (AC #4), 10+2 golden value 1.2 (AC #2), floor + ceiling clamps (AC #3), dismisses counted in denominator only, slope constant 0.3, `computePriority` scalar path unchanged (AC #1), resolver+coefficient overrides scalar, category-not-in-table fallback to scalar, undefined-category fallback, extreme values clamp on consumer side too, `buildCategoryCoefficients` aggregation produces 1.15 for 6+2 product fixture and 0.9 for 2+4 design fixture, min-sample filter, overrides excluded from accept/escalate counts, category filter scopes output, end-to-end wiring with generated table.

## Design decisions
- **Escalates reduce the coefficient, dismisses are neutral-to-negative**: the §10 formula uses `(accepts - escalates)` in the numerator but `(accepts + dismisses + escalates)` in the denominator. Dismiss signals lower the ratio (growing the denominator) without pulling it negative, since dismisses indicate "this shouldn't have been admitted" — a dampening signal, not a "score higher" signal.
- **Scalar path unchanged**: absence of `categoryResolver` OR absence of `categoryCoefficients` reverts to scalar. Both must be supplied to engage the category path. Preserves AC #1 backward compat.
- **Clamp at consumption AND at computation**: `computeCalibrationCoefficient` clamps on the way out of the formula; `computeCalibration` in priority.ts clamps again on the way in. Belts and suspenders — a malicious config can't sneak a 2.5 coefficient past the priority math.
- **Override signals ignored in accept/escalate math**: `buildCategoryCoefficients` increments a separate `overrides` counter but doesn't add to total. Matches the feedback-store precision semantics — override is a bypass, not a judgement on the scorer.
- **`buildCategoryCoefficients` returns a `Record<string, number>`** (not a keyed object of `CategoryFeedback`): consumers (`computePriority` config) need numeric coefficients, not raw counts. Keeps the wiring simple.
- **Categories filter is a hard allowlist, not a blocklist**: `buildCategoryCoefficients({categories: ['a']})` emits only 'a' regardless of other categories present. Useful for Phase-3 rollout where only certain categories are calibrated.
- **`computeCalibration` now takes `input` as first arg**: needed so the resolver can inspect the priority input's labels / description / itemId to pick a category. Minor signature change, fully internal.

## Verification
- `pnpm build` — clean (all 9 packages)
- `pnpm vitest run src/calibration.test.ts` — 16/16 pass
- `pnpm vitest run` (full orchestrator) — 2212/2212 pass (+16)
- `pnpm lint` — clean

## Follow-up
AISDLC-66 (phase-weight auto-calibration) uses `structuralPrecision` / `llmPrecision` to shift Phase 3 `wStructural` / `wLlm` nightly. AISDLC-67 (SoulDriftDetected + CoreIdentityChanged consumer) closes M6 — and the entire RFC-0008 implementation.
<!-- SECTION:FINAL_SUMMARY:END -->
