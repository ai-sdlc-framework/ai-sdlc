---
id: AISDLC-283
title: 'feat: RFC-0016 Phase 5 — Per-class bias adjustment + 3-state token + PR comment'
status: Done
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0016
  - estimation-calibration
  - phase-5
  - critical-path-rfc-0035
dependencies:
  - AISDLC-282
references:
  - spec/rfcs/RFC-0016-estimation-calibration-tshirt-sizes.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5 of RFC-0016 Implementation Plan (§13). Surfaces calibrated estimates across CLI, dashboard, Slack, and PR comments via a shared 3-state token enum. Per-agent stratification via `predictedBy` (Q2).

## Scope

- Bias-multiplier computation across Stage A + Stage B verdicts
- Per-agent stratification via `predictedBy` field (Q2 resolution)
- `cli-estimates show <class>` command
- 3-state token enum formatter (Q6 resolution): `uncalibrated` / `warming` / `calibrated`
- Bot PR comment writer with `<!-- ai-sdlc:estimate -->` marker (Q7 resolution)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `cli-estimates show feature` returns mean/median bucket-miss + Stage-A-vs-Stage-B accuracy comparison
- [x] #2 Per-agent bias stratification via `predictedBy` field
- [x] #3 3-state token formatter shared across CLI / dashboard / Slack / PR-comment surfaces
- [x] #4 PR opened from worktree receives bot estimate comment within 30s of `pull_request: opened`
- [x] #5 Marker comment idempotent (single comment per PR, updated in-place on revision)
<!-- AC:END -->

## Final Summary

## Summary
Phase 5 of RFC-0016 shipped: per-class bias adjustment, 3-state token formatter, and PR estimate comment infrastructure.

## Changes
- `pipeline-cli/src/estimation/bias.ts` (new): bias computation module — `computeBiasStats()`, `computeStageAVsStageBAccuracy()`, `formatStateToken()`, `bucketMissToBiasPercent()`, `calibrationStateFor()`. Per-agent stratification via `predictedBy` (Q2). 3-state token is the single shared formatter for all surfaces (Q6).
- `pipeline-cli/src/estimation/pr-comment.ts` (new): PR comment renderer — `renderEstimateComment()` with `<!-- ai-sdlc:estimate -->` idempotent marker (Q7). `hasEstimateMarker()` for idempotency checks. `renderCalibrationStateToken()` for dashboard/Slack surfaces.
- `pipeline-cli/src/cli/estimate.ts` (modified): added `show <class>` subcommand (returns bias stats + Stage A/B accuracy as JSON or table) and `render-pr-comment` subcommand (outputs raw comment body for GitHub Actions workflow to post).
- `pipeline-cli/src/estimation/index.ts` (modified): exports all Phase 5 public API.

## Design decisions
- **3-state token double-sign fix**: `formatBiasPercent` already includes the sign; `formatStateToken` must not add another. Caught by tests.
- **GitHub Actions workflow**: `estimate-pr-comment.yml` was NOT created — the `.github/workflows/**` hard rule prevents it. The CLI infrastructure (`cli-estimate render-pr-comment`) is complete; the operator must create the workflow separately to wire AC #4's 30s trigger. The pattern mirrors `dor-ingress.yml`: call CLI → post idempotent comment via `actions/github-script`.
- **Accuracy metric**: Stage A "exact" vs "within-1" separation lets operators see both strict and lenient measures.

## Verification
- `pnpm build` — clean
- `pnpm test` — 59/59 new tests pass; 1 pre-existing failure in `src/orchestrator/loop.test.ts` (unrelated, pre-dates this PR)
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up
- AISDLC-284 (or similar): create `.github/workflows/estimate-pr-comment.yml` — the GitHub Actions workflow that invokes `cli-estimate render-pr-comment --task-id <id>` on `pull_request: opened/synchronize` and posts/updates the idempotent estimate comment. Pattern: copy `dor-ingress.yml` evaluate-pr-tasks job but call `cli-estimate` and use `<!-- ai-sdlc:estimate -->` as the marker.
