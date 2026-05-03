---
id: AISDLC-161
title: 'Wire up DoR calibration data collection in CI + enable hybrid Phase-8 promotion path'
status: Done
assignee: []
created_date: '2026-05-02'
labels:
  - ci
  - dor
  - observability
  - rfc-0011
  - phase-7
milestone: m-3
dependencies:
  - AISDLC-115.8
references:
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
  - backlog/tasks/aisdlc-115.8 - Phase-7-Soak-tune-tessellated-platform-shard-naming.md
  - backlog/completed/aisdlc-115.9 - Phase-8-Enforce-flip-AI_SDLC_DOR_GATE-warn-only-→-enforce.md
  - docs/operations/dor-promotion.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Pre-AISDLC-161, the GitHub Action `dor-ingress.yml` invoked the DoR
evaluator on every issue + PR change but the calibration log was written
to the runner's tmpdir and discarded at job end. Net effect: zero
calibration data accumulated despite hundreds of workflow runs, blocking
AISDLC-115.8 AC #5 (corpus-driven exit criterion: false-positive rate
< 10% per gate).

This task wires the data collection end to end:

1. **CI side** — `dor-evaluate` now appends a calibration entry on every
   invocation; the workflow exports `ARTIFACTS_DIR=/tmp/dor/artifacts`
   and uploads `<ARTIFACTS_DIR>/_dor/calibration.jsonl` as a 90-day
   workflow artifact (`dor-calibration-issue-N-A` /
   `dor-calibration-pr-N-A`).
2. **Aggregator** — new `cli-dor-corpus aggregate` CLI reads N
   downloaded JSONL artifacts and computes per-gate FP rate +
   `recommendation` (`safe-to-enforce` / `continue-soak` /
   `insufficient-data`).
3. **Hybrid promotion path** — `docs/operations/dor-promotion.md`
   documents two operator paths to promote `warn-only → enforce`: the
   corpus path (math-rigorous) and the override path (operator
   spot-checks recent runs in the GitHub Actions UI). Both land at the
   same end-state; operator chooses based on data richness.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `dor-ingress.yml` exports `ARTIFACTS_DIR` and uploads `_dor/calibration.jsonl` as a 90-day workflow artifact for both the `evaluate-issue` and `evaluate-pr-tasks` jobs
- [x] #2 `dor-evaluate` CLI subcommand persists a calibration entry on every invocation (the GitHub-issues + PR-tasks ingress path), wrapped in try/catch so a log failure never poisons the verdict
- [x] #3 New `cli-dor-corpus aggregate <input>` CLI reads N JSONL files, computes per-gate FP rate + override rate, returns recommendation envelope (`safe-to-enforce` / `continue-soak` / `insufficient-data`); thresholds tunable via `--min-samples`, `--fp-threshold`, `--override-threshold`
- [x] #4 New CLI registered in `pipeline-cli/package.json` `bin` section + bin shim at `pipeline-cli/bin/cli-dor-corpus.mjs`
- [x] #5 Hermetic test coverage: empty corpus, single-file all-admit, mixed admits + overrides, N=1000 with ~9% per-gate override (safe-to-enforce path), schema validation (malformed entries skipped + counted), multi-file gh-run-download layout
- [x] #6 New `docs/operations/dor-promotion.md` documents both promotion paths (corpus + operator-override) with `gh run download` recipe
- [x] #7 Pre-flight passes: `pnpm --filter @ai-sdlc/pipeline-cli build && test && lint && format:check`
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Patch `pipeline-cli/src/cli/index.ts` `dor-evaluate` handler to call
   `appendCalibrationEntry()` after evaluation (try/catch so the verdict
   path remains the user-facing contract).
2. Patch `.github/workflows/dor-ingress.yml`:
   - Export `ARTIFACTS_DIR=/tmp/dor/artifacts` in both jobs
   - Add `actions/upload-artifact@v4` step at end of each job, retention
     90 days, `if: always()` so failed evals still leave a trail
3. Add `pipeline-cli/src/cli/dor-corpus.ts` (`aggregate` subcommand,
   pure aggregator, schema validator, dir-walker, table renderer) +
   `pipeline-cli/bin/cli-dor-corpus.mjs` shim + register in
   `pipeline-cli/package.json` `bin`.
4. Add `pipeline-cli/src/cli/dor-corpus.test.ts` covering the matrix in
   AC #5.
5. Add `docs/operations/dor-promotion.md` with the corpus-path +
   override-path recipes.
6. Pre-flight + commit.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:SUMMARY:BEGIN -->
## Summary

Wired up the DoR calibration data collection end-to-end so AISDLC-115.8's
corpus-driven exit criterion has data to reason about. The `dor-evaluate`
CLI now persists a calibration entry on every invocation; the
`dor-ingress.yml` workflow exports `ARTIFACTS_DIR` and uploads the JSONL
as a 90-day workflow artifact for both the issues + PR-tasks jobs; a new
`cli-dor-corpus aggregate` CLI reads N downloaded artifacts and emits a
per-gate FP-rate report + `recommendation` envelope
(`safe-to-enforce` / `continue-soak` / `insufficient-data`). The
hybrid-promotion runbook (`docs/operations/dor-promotion.md`) documents
both the corpus path and the operator-override fallback so AISDLC-115.9
isn't gated on calendar time when corpus is sparse.

## Changes

- `pipeline-cli/src/cli/index.ts` (modified): `dor-evaluate` handler now
  calls `appendCalibrationEntry()` after evaluation; wrapped in try/catch
  so a log failure never poisons the verdict.
- `.github/workflows/dor-ingress.yml` (modified): both jobs export
  `ARTIFACTS_DIR=/tmp/dor/artifacts`; both jobs upload
  `_dor/calibration.jsonl` as a 90-day workflow artifact named
  `dor-calibration-{issue|pr}-N-A`.
- `pipeline-cli/src/cli/dor-corpus.ts` (new): `aggregate` subcommand,
  pure FP-rate aggregator, schema validator, recursive dir-walker, table
  renderer.
- `pipeline-cli/bin/cli-dor-corpus.mjs` (new): bin shim forwarding to
  the compiled router.
- `pipeline-cli/package.json` (modified): registered `cli-dor-corpus`
  bin.
- `pipeline-cli/src/cli/dor-corpus.test.ts` (new): hermetic coverage
  matrix per AC #5 (empty corpus, all-admit, mixed override, N=1000
  safe-to-enforce path, schema validation, multi-file gh-run-download
  layout).
- `docs/operations/dor-promotion.md` (new): runbook for the two
  promotion paths (corpus + operator-override).

## Design decisions

- **`dor-evaluate` writes calibration directly** (rather than a separate
  workflow step) — keeps the GitHub Action ingress on the same write
  path as the existing local `dor-refine-task` flow. Writing is wrapped
  in try/catch so a log failure never poisons the verdict.
- **Separate `cli-dor-corpus` (not extended `cli-dor-stats`)** — the
  two CLIs have distinct contracts: `cli-dor-stats` operates on ONE
  local log file; `cli-dor-corpus` operates on N downloaded artifacts
  and produces a `recommendation` envelope. Mixing them invited
  confusion at the exact moment the operator needs clarity.
- **Schema validation skips, not crashes** — an artifact downloaded
  from a stranger's PR run could in principle contain anything; we'd
  rather drop a malformed line and count it (`skipped` field) than
  poison the FP-rate math.
- **Override-path fallback documented** — corpus path is preferred but
  AISDLC-115.9 isn't gated on calendar time. Operator can spot-check
  the GitHub Actions UI and dispatch with documented rationale.

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 1070 tests passing,
  20 new dor-corpus tests
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Smoke test: `node pipeline-cli/bin/cli-dor-corpus.mjs aggregate
  /tmp/dor-smoke --format table` against a 2-file fixture corpus
  produced expected per-gate breakdown + `continue-soak` recommendation

## Follow-up

- AISDLC-115.8 owner can now run the aggregator after a soak window to
  decide on AISDLC-115.9 dispatch
- AISDLC-115.9 promotes `evaluationMode: warn-only → enforce` once the
  recommendation lands `safe-to-enforce` (or operator dispatches via
  override path)
- Slack-digest integration with the aggregator output (Phase 5
  territory; revisit post-115.9)
<!-- SECTION:SUMMARY:END -->
