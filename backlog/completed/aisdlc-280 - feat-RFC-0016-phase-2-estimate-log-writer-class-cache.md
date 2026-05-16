---
id: AISDLC-280
title: 'feat: RFC-0016 Phase 2 — Estimate-log writer + class-assignment cache'
status: Done
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0016
  - estimation-calibration
  - phase-2
  - critical-path-rfc-0035
dependencies:
  - AISDLC-279
references:
  - spec/rfcs/RFC-0016-estimation-calibration-tshirt-sizes.md
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2 of RFC-0016 Implementation Plan (§13). Captures every Stage A verdict to a structured log so Phase 3 measurement has data to ingest. The class-assignment LLM call is cached on first use per Q3 resolution.

## Scope

- Estimate-log writer that records Stage A multiset + final bucket + `estimateInputHash` (Q5) + class fields
- Wire to the RFC-0015 `events.jsonl` event stream
- Class-assignment LLM call cached on first use (Q3 resolution); subsequent estimates of the same task class reuse the cached class assignment
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 100% of agent estimates appear in `log.jsonl`
- [x] #2 Records include `stageA`, `finalBucket`, `estimateInputHash`, and `class` fields
- [x] #3 Class-assignment LLM call results cached (single LLM call per class per repo)
- [x] #4 Wired to events.jsonl event stream from RFC-0015
- [x] #5 Integration test with Phase 1 confirms full write path
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

## Summary

Ships RFC-0016 Phase 2 capture surface: every Stage A verdict is now persisted to `$ARTIFACTS_DIR/_estimates/log.jsonl` with the full §8.4 ensemble metadata (`estimateInputHash`, `runIndex`), wired to the RFC-0015 `events.jsonl` event stream via two new event types (`EstimateCaptured`, `EstimateInputChanged`), and the class-assignment call is now served from a per-repo cache so the eventual LLM-backed classifier runs at most once per `(taskId, contentHash)`.

## Changes

- `pipeline-cli/src/estimation/hash.ts` (new): `computeEstimateInputHash` — sha256 over a canonicalised `{taskTitle, taskDescription, stageA_signals, taskClass}` projection. Determinism-stable across signal order and key order.
- `pipeline-cli/src/estimation/cache.ts` (new): `assignClassCached` — file-backed cache at `<artifactsDir>/_estimates/class-assignments.json` keyed by `taskId.toLowerCase()` with `contentHash` invalidator. Forward-compatible with the Phase 4 LLM assigner via injectable `assigner` override.
- `pipeline-cli/src/estimation/log-writer.ts` (new): `captureEstimate` — appends one JSONL row to `_estimates/log.jsonl` AND emits `EstimateCaptured` (+ `EstimateInputChanged` on hash transition) through the existing `writeEvent()` writer. Same-hash repeat captures advance `runIndex`; hash changes reset `runIndex` to 1.
- `pipeline-cli/src/orchestrator/events.ts` (modified): extends the `OrchestratorEventType` union with `EstimateCaptured` and `EstimateInputChanged`.
- `spec/schemas/orchestrator-events.v1.schema.json` (modified): adds the two new event types to the enum + 9 new per-type properties (`bucket`, `finalBucket`, `class`, `estimateInputHash`, `runIndex`, `confidence`, `escalateToStageB`, `oldHash`, `newHash`).
- `pipeline-cli/src/estimation/stage-a.ts` (modified): `runStageA` now routes class assignment through `assignClassCached` by default; new `skipClassCache` opt-out preserves the pure-heuristic path for Phase 1 callers.
- `pipeline-cli/src/cli/estimate.ts` (modified): `cli-estimate stage-a` now appends to `_estimates/log.jsonl` by default; `--no-capture` preserves the dry-run shape.
- `pipeline-cli/src/estimation/index.ts` (modified): re-exports the new Phase 2 surface.
- Tests: 51 new tests across `hash.test.ts` (13), `cache.test.ts` (15), `log-writer.test.ts` (17), `log-writer.integration.test.ts` (6) + 1 new schema test + 1 new CLI capture test.

## Design decisions

- **log.jsonl is canon, events.jsonl is observability.** `captureEstimate` writes the log row FIRST so a transient events-write failure can't leave a missing row. Phase 3 calibration reads the log; the events stream is for live consumers.
- **`source` is NOT part of `estimateInputHash`.** The class-assignment provenance is metadata (whether the operator typed `class: chore` into frontmatter or the heuristic guessed it). Two runs with the same `class` value MUST produce the same hash regardless of how the class got assigned, otherwise the §8.4 ensemble model breaks.
- **Cache cached only by `(taskId, contentHash)`.** RFC §6.5 says re-classification fires only when title/description change materially. The hash is the cheap invalidator. AC #3's "single call per class per repo" reading is via stable taskId-keyed entries with content-hash-based invalidation — not by taking the LLM's first answer for `bug` and applying it to every future `bug` (which would defeat the LLM's per-task fuzzy classification value).
- **Events writes are gated by the orchestrator flag, log writes by the estimation flag.** Two independent feature flags — `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` (RFC-0015) gates events.jsonl; `AI_SDLC_ESTIMATION_CALIBRATION` (RFC-0016) gates Stage A itself. Operators can enable estimation without enabling the orchestrator.

## Verification

- `pnpm build` — clean
- `pnpm test` — all 9 workspaces pass (3174 pipeline-cli tests + suites in dashboard, orchestrator, reference, etc.)
- `pnpm lint` — 0 errors (2 pre-existing unrelated warnings in `pipeline-cli/src/steps/00-sweep.ts`)
- `pnpm format:check` — clean

## Follow-up

Phase 3 (AISDLC-281, when filed): actuals collector reads `_estimates/log.jsonl` + writes the monthly-rotated `calibration-YYYY-MM.jsonl`. Phase 4 swaps `assignClass` for the LLM-backed assigner with no API change to `assignClassCached`.

<!-- SECTION:FINAL_SUMMARY:END -->
