---
id: AISDLC-310
title: 'feat: RFC-0031 Refit — per-org calibration.yaml config (OQ-12.1 + OQ-12.5)'
status: Done
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0031
  - refit
  - audit-followup
  - per-org-config
dependencies: []
references:
  - spec/rfcs/RFC-0031-calibration-driven-did-revision-proposal.md
  - orchestrator/src/sa-scoring/revision-proposal.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0031 OQ-12.1 (confidence thresholds) and OQ-12.5 (rejection weights + formula) audit affirmed the shipped values as defaults but added per-org config exposure as an additive refinement. This task bundles both into one calibration.yaml schema extension.

## Why two OQs in one task

Both touch the same file (`.ai-sdlc/calibration.yaml`) + same module (`revision-proposal.ts`). Bundling minimizes code churn + lets `loadCalibrationConfig()` get extended once rather than twice.

## Scope (OQ-12.1)

- Read `confidenceThresholds.highSampleSize` (default 20) + `confidenceThresholds.lowSampleSize` (default 5) from `.ai-sdlc/calibration.yaml`.
- Pass through to `computeConfidence()`.
- Validate sensible bounds at load time (`highSampleSize > lowSampleSize`; both > 0).

## Scope (OQ-12.5)

- Read `rejectionPrecedent.weights.{high,medium,low}ConfidenceRejection` from `.ai-sdlc/calibration.yaml` (defaults: 0.8 / 0.5 / 0.2).
- Read `rejectionPrecedent.confidencePenaltyFloor` (default 0.2).
- `formula` field is documentation-only in v1 (operator can read what shipped); future v2 can parse the formula string.
- Pass through to `computeRejectionPrecedentFactor()`.

## Known future gap (documented, NOT in scope for this task)

OQ-12.5 audit noted: the flat-mean rejection formula has no recency weighting, so old rejections suppress current legitimate drift indefinitely. Per-org config is the v1 escape hatch (operator can lower weights to mitigate). A future v2 task can introduce exponential decay over rejection age — out of scope for this refit.

## Composition

- Extends the existing `CalibrationLockConfig` type from OQ-12.3 (shipped) — same loader, same call site.
- See RFC-0031 §12.6 for the consolidated schema.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `confidenceThresholds.highSampleSize` + `lowSampleSize` read from calibration.yaml (defaults: 20, 5)
- [ ] #2 `rejectionPrecedent.weights.*` read from calibration.yaml (defaults: 0.8 / 0.5 / 0.2)
- [ ] #3 `rejectionPrecedent.confidencePenaltyFloor` read from calibration.yaml (default: 0.2)
- [ ] #4 Validation at load time: `highSampleSize > lowSampleSize > 0`; weights in `[0, 1]`; floor in `[0, 1]`
- [ ] #5 Defaults shipped in `ai-sdlc init` calibration template
- [ ] #6 Test coverage: default load + override load + invalid config rejection
- [ ] #7 RFC-0031 §12.6 schema kept in sync with implementation
<!-- AC:END -->
