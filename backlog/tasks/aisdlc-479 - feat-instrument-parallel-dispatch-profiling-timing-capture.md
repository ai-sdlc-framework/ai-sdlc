---
id: AISDLC-479
title: "feat: instrument parallel-dispatch profiling — persist per-task timing for throughput + estimation"
status: To Do
assignee: []
created_date: '2026-05-29 16:55'
labels:
  - orchestrator
  - corpus
  - parallelism
  - observability
dependencies: []
references:
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

A 2026-05-29 audit found that per-task execution timing is DEFINED in the schemas but never actually captured or persisted:

- `spec/schemas/dispatch-verdict.v1.schema.json` defines `durationMs` and `completedAt`; `spec/schemas/dispatch-manifest.v1.schema.json` defines `dispatchedAt` — but the dispatch board never lands timed verdicts, so those fields stay unset.
- `pipeline-cli/src/orchestrator/events.ts` defines the `OrchestratorCompleted` and `OrchestratorFailed` event types, but they are never emitted; only `OrchestratorDispatched` (which carries no duration) is written to `artifacts/_orchestrator/events-YYYY-MM-DD.jsonl`.
- The `WorkerStateTransition` `duration_ms` value in `pipeline-cli/src/orchestrator/playbook/` is computed in-memory but never persisted (a "Phase 4 will write these" deferral that has not been actioned).
- The estimation calibration channel `_estimates/calibration-YYYY-MM.jsonl` (`EstimateActualsRecorded.actualWallClockSec`) is empty.

Result: we cannot profile throughput or feed task-estimation evaluation with real actuals. The schemas and event types already exist; the wiring that produces records into them does not. This task closes that gap so parallel-dispatch profiling becomes measurable.

## Goal

Wire the timing capture end-to-end so every dispatched task persists a profiling record, and provide an aggregator that produces a throughput and estimation report.

## Implementation notes

Build on the existing `events.ts` writer and the existing corpus aggregators (`cli-orchestrator-corpus`, `cli-deps-corpus`). Reuse `spec/schemas/dispatch-verdict.v1.schema.json` and `spec/schemas/dispatch-manifest.v1.schema.json` rather than defining new shapes. Follow the Runner-injection hermetic-test pattern used across the pipeline-cli steps so the new emission and aggregation paths can be tested without touching the real filesystem or clock.

## References

- spec/rfcs/RFC-0014-dependency-graph-composition.md — deps composition + corpus aggregators that this profiling channel extends
- spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md — events.jsonl writer + orchestrator event types being completed here
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->

- [ ] AC-1: When the orchestrator/dispatch path completes a task, an `OrchestratorCompleted` event (carrying `taskId`, `ts`, `durationMs`, `outcome`) and on failure an `OrchestratorFailed` event are emitted to `artifacts/_orchestrator/events-YYYY-MM-DD.jsonl` via the existing `writeEvent` in `pipeline-cli/src/orchestrator/events.ts`.
- [ ] AC-2: Dispatch-board verdicts written to `.ai-sdlc/dispatch/done/<task-id>.verdict.json` populate `dispatchedAt`, `completedAt`, and `durationMs` (already present in the verdict schema) instead of leaving them unset.
- [ ] AC-3: A new aggregator subcommand (`cli-orchestrator-corpus profile` or a new `cli-profiling aggregate`) reads the events plus verdicts and emits a per-task and summary throughput report (count, p50/p95 `durationMs`, success rate) and writes or appends actuals to `_estimates/calibration-YYYY-MM.jsonl` as `EstimateActualsRecorded` records.
- [ ] AC-4: Records use the field names already defined in the existing schemas (`durationMs`, `dispatchedAt`, `completedAt`, `actualWallClockSec`); the implementation does not invent parallel field names.
- [ ] AC-5: Hermetic unit tests cover event emission on completion and failure, verdict timing population, and the aggregator report math (p50/p95, success rate) with fixture data, at 80% patch coverage.
- [ ] AC-6: A short `docs/operations/dispatch-profiling.md` explains where timing is captured, the file paths involved, and how to run the aggregator.
- [ ] AC-7: No behaviour change when `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` is off; the writers stay gated exactly as they are today.

<!-- AC:END -->
