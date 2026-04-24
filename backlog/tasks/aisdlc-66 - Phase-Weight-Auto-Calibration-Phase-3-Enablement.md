---
id: AISDLC-66
title: Phase Weight Auto-Calibration (Phase 3 Enablement)
status: Done
assignee: []
created_date: '2026-04-24 17:27'
updated_date: '2026-04-24 19:51'
labels:
  - calibration
  - phase-weights
  - M6
milestone: m-1
dependencies:
  - AISDLC-64
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
§B.8 calibration effects. Create `orchestrator/src/sa-scoring/auto-calibrate.ts`.

Nightly or on-demand: reads `SAFeedbackStore`, computes per-dimension Phase 3 weights:
- If `llmPrecision > structuralPrecision + 0.1` → shift toward LLM
- If reverse → shift toward structural
- Enforce `w_structural >= 0.20` floor (CR-2)

Write weights to new `sa_phase_weights(dimension, w_structural, w_llm, calibrated_at)` table (migration V12 if M4 used V11, or inline in V11).

CLI: `ai-sdlc sa-calibrate` prints computed weights diff before persisting.

Rolling 90-day window for calibration. Idempotent when feedback unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Phase 3 weights respect floor (w_structural >= 0.20)
- [x] #2 Idempotent when feedback unchanged
- [x] #3 Rolling 90-day window for calibration
- [x] #4 CLI emits diff vs. previous weights
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Phase 3 weight auto-calibration landed. `autoCalibratePhaseWeights` reads trailing-90-day precision from `SAFeedbackStore`, shifts `(w_structural, w_llm)` toward the better-performing layer, and persists to a new `sa_phase_weights` table. `sa-calibrate` CLI prints a diff before writing (supports `--dry-run`).

## Changes
- `orchestrator/src/state/schema.ts`: bumped `CURRENT_SCHEMA_VERSION` to 12; added `MIGRATION_V12` creating `sa_phase_weights` (`dimension UNIQUE`, `w_structural`, `w_llm`, `calibrated_at`, CHECK constraints on weight range 0-1).
- `orchestrator/src/state/types.ts`: new `SaPhaseWeightsRecord` type.
- `orchestrator/src/state/store.ts`: `upsertSaPhaseWeights` + `getSaPhaseWeights` methods (ON CONFLICT keyed by dimension).
- `orchestrator/src/sa-scoring/auto-calibrate.ts` (new): pure `decideCalibrationDirection(precision)` returns `'toward-llm' | 'toward-structural' | 'hold'`. `computePhase3Weights({current, precision, shiftSize?})` applies the shift and clamps `w_structural ∈ [0.20, 0.80]` (CR-2 floor + symmetric LLM floor). `autoCalibratePhaseWeights(deps)` orchestrates per-dimension: reads current weights (or Phase-2c defaults), reads precision for the 90d window, computes next, persists only when the weight pair changed (idempotency). Exports `WEIGHT_FLOOR`, `WEIGHT_CEILING`, `DEFAULT_SHIFT_SIZE`, `DEFAULT_WINDOW_DAYS`, `PRECISION_DELTA_THRESHOLD`. `renderCalibrationDiff(result)` formats for the CLI.
- `orchestrator/src/sa-scoring/auto-calibrate.test.ts` (new): 18 tests — decide direction threshold, computePhase3Weights shifts directionally, hold when delta small, CR-2 floor clamp (AC #1), symmetric ceiling clamp, custom shift size, autoCalibrate first-run persistence, idempotency via calibratedAt comparison (AC #2), LLM-preferred shift, structural-preferred shift, windowDays override plumbs through (AC #3), DEFAULT_WINDOW_DAYS constant = 90, calibrated weights flow back into next run as `previous`, renderCalibrationDiff shape (AC #4 — previous/next/precision/changed fields).
- `orchestrator/src/index.ts`: exported new public API (`autoCalibratePhaseWeights`, `computePhase3Weights`, `decideCalibrationDirection`, `renderCalibrationDiff`, constants, types).
- `dogfood/src/cli-sa-calibrate.ts` (new): `sa-calibrate` CLI with `--window-days`, `--shift-size`, `--dry-run` flags. Dry-run uses a shadow in-memory `StateStore` seeded with current weights so the diff reports correct `previous` without persisting.
- `dogfood/package.json`: added `sa-calibrate` script.

## Design decisions
- **V12 migration rather than amending V11**: M1 already shipped V11 with the RFC-0008 tables. Adding a new migration for M6 preserves forward-only semantics — databases created against V11 upgrade cleanly.
- **Symmetric `w_llm ≥ 0.20` floor**: CR-2 only mandates `w_structural ≥ 0.20`, but by clamping `w_structural ≤ 0.80` we enforce the same floor on `w_llm`. Extreme single-layer dominance is never written — feedback calibration can't turn the scorer into a pure-structural or pure-LLM mode.
- **Idempotency via weight-pair equality, not precision stability**: if the computed next weights equal the persisted previous weights, the row is NOT re-written — `calibrated_at` stays stable. This matters when the calibration workflow runs nightly but feedback hasn't changed materially.
- **First-run always persists** even when the computed pair equals the starting default: initialises the `sa_phase_weights` table so subsequent runs can report the actual `previous`. `diffs[i].changed` correctly reports `false` when no shift happened, but the DB still gets the row.
- **Dry-run via shadow in-memory store**: the CLI copies current `sa_phase_weights` rows into a fresh `:memory:` store, runs the calibration against that shadow, prints the diff, then closes the shadow without persisting to the real DB. Clean separation without adding a `dryRun` parameter to the compute function.
- **Starting weights = Phase 2c defaults (0.35, 0.65)**: when Phase 3 activates with no prior calibration, we inherit the Phase 2c weights. Shifts from there based on feedback, so operators can progress 2c → 3 smoothly.
- **90-day default window matches the C3 `getCodeAreaMetrics` window and the design-quality-trend analyzer**: consistent rolling-window semantics across RFC-0008 features.

## Verification
- `pnpm build` — clean (all 9 packages)
- `pnpm vitest run src/sa-scoring/auto-calibrate.test.ts` — 18/18 pass
- `pnpm vitest run` (full orchestrator) — 2230/2230 pass (+18)
- `pnpm test` (full workspace) — no regressions
- `pnpm lint` — clean

## Follow-up
AISDLC-67 (SoulDriftDetected + CoreIdentityChanged consumer) is the last task — closes M6 and the entire RFC-0008 implementation.
<!-- SECTION:FINAL_SUMMARY:END -->
