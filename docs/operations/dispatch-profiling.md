# Dispatch profiling — per-task timing capture (AISDLC-479)

The parallel-dispatch path now **captures and persists** per-task execution
timing so the orchestrator can compute throughput and feed the estimation
calibration loop. Pre-AISDLC-479 the timing fields were defined in the
schemas but never written; this page documents where timing is captured,
the on-disk file paths, and how to run the aggregator.

> Builds on RFC-0014 (deps composition) + RFC-0015 (autonomous
> orchestrator). Reuses the existing `events.ts` writer + `cli-orchestrator-corpus`
> aggregator + the two dispatch schemas — no new field names were invented.

## Where timing is captured

| Surface | What is written | When |
|---|---|---|
| `artifacts/_orchestrator/events-YYYY-MM-DD.jsonl` | `OrchestratorCompleted` (`taskId`, `ts`, `durationMs`, `outcome`) on success; `OrchestratorFailed` on failure | When a Worker finishes a task and emits its verdict |
| `.ai-sdlc/dispatch/done/<task-id>.verdict.json` (+ `failed/`) | `dispatchedAt`, `completedAt`, `durationMs` (fields already in `dispatch-verdict.v1.schema.json`) | When the Worker writes its verdict to the Dispatch Board |
| `artifacts/_estimates/calibration-YYYY-MM.jsonl` | `EstimateActualsRecorded` records carrying `actualWallClockSec` + `durationMs` (+ `dispatchedAt`/`completedAt` when known) | When the aggregator is run with `--write-actuals` |

### Field names

Only the **existing** schema field names are used:

- `durationMs` — wall-clock from dispatch to verdict, in milliseconds.
- `dispatchedAt` — ISO-8601 dispatch anchor (copied from the manifest).
- `completedAt` — ISO-8601 verdict-emit timestamp.
- `actualWallClockSec` — `round(durationMs / 1000)`; the calibration loop's
  unit.

## Gating (no behaviour change when off)

Event emission rides the existing `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` gate
inside `writeEvent` — when the orchestrator is off, no events are written,
exactly as `OrchestratorDispatched` behaves today. Verdict timing fields are
populated unconditionally (the verdict file is written by the Worker
regardless of the flag; stamping three already-schema'd fields is a pure
data-completeness change).

## Code surface

- `pipeline-cli/src/orchestrator/profiling.ts`
  - `emitTaskCompletion()` / `emitTaskFailure()` — emit the timed events.
  - `populateVerdictTiming()` — fill a verdict's timing fields from the
    manifest (never mutates the input).
  - `writeTimedVerdict()` — Worker-side composite: populate timing → write
    verdict to the board → emit the matching completion/failure event.
- `pipeline-cli/src/cli/profile-aggregator.ts`
  - `aggregateProfile()` — pure per-task + summary throughput math
    (count, p50/p95 `durationMs`, success rate) + builds
    `EstimateActualsRecorded` records.
  - `readProfilingEvents()` / `readBoardVerdicts()` — the I/O readers.
- `pipeline-cli/src/cli/orchestrator-corpus.ts` — the `profile` subcommand +
  `appendActualsToCalibration()`.

## Running the aggregator

The `profile` subcommand reads the events stream + the Dispatch Board and
emits a throughput report:

```bash
# JSON report (default)
node pipeline-cli/bin/cli-orchestrator-corpus.mjs profile \
  --artifacts-dir ./artifacts \
  --board-dir ./.ai-sdlc/dispatch

# Human-readable table
node pipeline-cli/bin/cli-orchestrator-corpus.mjs profile --format table

# Also append EstimateActualsRecorded records to the calibration log
node pipeline-cli/bin/cli-orchestrator-corpus.mjs profile --write-actuals
```

Defaults: `--artifacts-dir` falls back to `$ARTIFACTS_DIR` then `./artifacts`;
`--board-dir` defaults to `./.ai-sdlc/dispatch`.

### Report shape

```jsonc
{
  "perTask": [
    {
      "taskId": "AISDLC-479",
      "durationMs": 120000,
      "outcome": "success",
      "success": true,
      "dispatchedAt": "2026-05-29T00:00:00.000Z",
      "completedAt": "2026-05-29T00:02:00.000Z",
      "source": "verdict"
    }
  ],
  "summary": {
    "taskCount": 1,
    "successCount": 1,
    "successRate": 1.0,
    "durationSampleCount": 1,
    "p50DurationMs": 120000,
    "p95DurationMs": 120000,
    "totalDurationMs": 120000
  },
  "actuals": [
    {
      "ts": "2026-05-29T12:00:00.000Z",
      "type": "EstimateActualsRecorded",
      "taskId": "AISDLC-479",
      "actualWallClockSec": 120,
      "durationMs": 120000,
      "dispatchedAt": "2026-05-29T00:00:00.000Z",
      "completedAt": "2026-05-29T00:02:00.000Z"
    }
  ]
}
```

### De-duplication + idempotency

- A task present in BOTH the verdict set and the event set is reported once;
  the **verdict wins** (it carries `dispatchedAt`/`completedAt` the event
  omits). The event is the fallback for tasks whose verdict was already
  swept by the Conductor.
- `--write-actuals` is idempotent by `taskId` within a month file: re-running
  over the same corpus does not double-append. Records route into the month
  derived from each record's own `ts`.

## Percentile method

`p50` / `p95` use the **nearest-rank** method (`rank = ceil(p · n)`,
1-indexed) rather than linear interpolation. For the small, discrete
duration corpora the orchestrator produces, the actual observed value at a
rank is more interpretable to an operator than an interpolated phantom
value.
