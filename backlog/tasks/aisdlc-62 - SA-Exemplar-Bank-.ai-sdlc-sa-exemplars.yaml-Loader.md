---
id: AISDLC-62
title: SA Exemplar Bank + .ai-sdlc/sa-exemplars.yaml Loader
status: Done
assignee: []
created_date: '2026-04-24 17:26'
updated_date: '2026-04-24 19:31'
labels:
  - sa-scoring
  - exemplars
  - M5
milestone: m-1
dependencies:
  - AISDLC-38
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
  - backlog/completed/aisdlc-8.4
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Port review-exemplar pattern from AISDLC-8.4 (Tutorial 09) to SA context.

Create `spec/schemas/sa-exemplar.schema.json`. Entry format per §B.6.4:
```yaml
id: string
dimension: SA-1 | SA-2
type: false-positive | true-negative | true-positive | false-negative
issue: { title, body }
layer1: { scopeGate, constraintViolations, antiPatternHits }
layer2: { domainRelevance } (optional, expected value)
layer3Expected: { domainIntent, reasoning } (optional)
verdict: string
principle: string (reference to design principle)
```

Create loader in `orchestrator/src/sa-scoring/exemplar-bank.ts` from `.ai-sdlc/sa-exemplars.yaml`.

Used in Phase 2a shadow-mode reporting to compute precision-per-layer.

Phase 2b gate requires ≥5 exemplars covering both TP and FP (§B.10.2). Helper `validatePhase2bExemplars(bank)` returns explicit gap list.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Schema validates the three §B.6.4 example exemplars
- [x] #2 Loader returns { sa1: [], sa2: [] } when file missing (no error)
- [x] #3 validatePhase2bExemplars(bank) returns explicit gap list (< 5 total, no TP, no FP)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
SA exemplar bank loader + Phase-2b readiness gate landed. `loadExemplarBank(path)` reads and validates `.ai-sdlc/sa-exemplars.yaml`, partitions entries by dimension, and returns `{sa1, sa2}`. `validatePhase2bExemplars(bank)` returns an explicit gap list for operators — ≥5 total, ≥1 TP + ≥1 FP per dimension (regression tracking).

## Changes
- `spec/schemas/sa-exemplar.schema.json` (new): JSON Schema (Draft 2020-12) validating `{exemplars: [...]}` shape with enum constraints on `dimension` (SA-1/SA-2), `type` (true-positive/false-positive/true-negative/false-negative), and required `id`, `issue`, `verdict`.
- `orchestrator/src/sa-scoring/exemplar-bank.ts` (new): loader (`loadExemplarBank`) with inline validation (returns empty bank when file missing — AC #2), `validatePhase2bExemplars` gap-list helper (AC #3), `computeLayerPrecision` helper for Phase-2a shadow mode reporting (TP/FP/TN/FN → precision + recall). Exports `SaExemplar`, `SaExemplarBank`, `ExemplarType`, `Layer1Expected`, `Layer2Expected`, `Layer3Expected`, `ExemplarGap`, `ExemplarReadinessResult`, `LayerPrecision`, `MIN_TOTAL_EXEMPLARS`.
- `orchestrator/src/sa-scoring/exemplar-bank.test.ts` (new): 17 tests — missing-file returns empty bank (AC #2), partition by dimension, preserves expected-layer fields, required-field errors, invalid-enum errors, malformed YAML handling, missing-exemplars-array error, non-array error, Phase-2b gap list flags total <5 + missing TP + missing FP (AC #3), flags entire missing dimension, passes with balanced bank, MIN constant = 5, precision/recall arithmetic, empty-list + no-TP-or-FP edges, §B.6.4 example round-trip (AC #1).

## Design decisions
- **Schema stands alone, not part of AnyResource**: exemplars are a testing/tracking artifact for operators, not a resource kind that runs through the reconciler loop. Keeps the main schema registry focused.
- **Empty-bank on missing file, not error**: Phase 2a can run without any exemplars; the gate check is explicit via `validatePhase2bExemplars`. Automatic empty-return removes a branch from every caller.
- **Phase-2b gate treats both dimensions independently**: a bank with 10 SA-1 exemplars and 0 SA-2 exemplars still fails — can't trust SA-2 ranking without SA-2 evidence. Per-dimension TP+FP minimum ensures we know both when the layer fires correctly AND when it over-fires.
- **`computeLayerPrecision` exposes precision and recall** (not F1): operators want to see both sides separately during Phase 2a to understand where the layer is over-firing vs under-firing. F1 can be derived from either.
- **Inline validation rather than full JSON Schema validator**: the loader hand-checks enum + required fields, throwing actionable error messages. Cheaper than wiring ajv + compiling the schema at runtime; the external schema exists for IDE tooling and CI pre-commit hooks.
- **No Phase-2b gate on recall, only precision**: §B.10.2 requires presence of both TP and FP, not quantitative precision thresholds. The expectation is "have evidence that both modes of the layer behave as intended" — actual precision calibration happens in M6 via the feedback flywheel.

## Verification
- `pnpm build` — clean (all 9 packages)
- `pnpm vitest run src/sa-scoring/exemplar-bank.test.ts` — 17/17 pass
- `pnpm vitest run` (full orchestrator) — 2169/2169 pass (+17)
- `pnpm lint` — clean

## Follow-up
AISDLC-63 (orchestration) wires `computeSoulAlignment` into the admission composite with exemplar-bank-driven phase gating: `validatePhase2bExemplars` must pass before Phase 2b can activate.
<!-- SECTION:FINAL_SUMMARY:END -->
