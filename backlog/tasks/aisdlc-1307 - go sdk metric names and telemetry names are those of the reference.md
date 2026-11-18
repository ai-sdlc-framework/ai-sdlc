---
id: AISDLC-1307
title: 'Go SDK metric names and telemetry names are those of the reference'
status: To Do
assignee: []
created_date: '2026-11-17'
labels:
  - sdk-go
  - sdk-parity
  - breaking-change
dependencies: []
references:
  - reference/src/metrics/types.ts
  - reference/src/telemetry/semantic-conventions.ts
  - sdk-go/metrics/types.go
  - sdk-go/metrics/metrics_test.go
  - sdk-go/telemetry/conventions.go
  - sdk-go/telemetry/telemetry_test.go
  - sdk-go/README.md
priority: medium
dispatchable: true
dispatchableReason: 'Operator ruling of 2026-11-17 (decision rubric): the Go SDK carries the reference metric and telemetry names only, in one 0.x release; Go-only names are removed and the release note carries an old-to-new table. Rejected: a deprecation period, a superset of both name sets, exempting Go from parity. The SDK survey of the same day found 10 standard metrics in Go that share no name with the 27 of the reference, and 21 telemetry names that differ from the 46 of the reference.'
---

## Description

**Gap.** `reference/src/metrics/types.ts` lists 27 standard metrics in five categories (`task-effectiveness`, `human-in-loop`, `code-quality`, `economic-efficiency`, `autonomy-trajectory`). `sdk-go/metrics/types.go` lists 10 metrics in four other categories (`quality`, `performance`, `security`, `compliance`); no name is shared. `reference/src/telemetry/semantic-conventions.ts` defines 7 span names, 26 metric names and 13 attribute keys. `sdk-go/telemetry/conventions.go` defines other strings: span names with a hyphen prefix (`ai-sdlc.evaluate_gate`), metric names such as `ai_sdlc.gate.passed`, attribute keys such as `ai_sdlc.gate.name`. A dashboard or a query written for the reference names finds nothing in data that a Go program emits.

**Shape.** The Go SDK defines exactly the standard metrics, span names, metric names and attribute keys of the reference, with the same string values. Names that only Go had are removed in the same change.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must Go emit the reference names? Yes, by the operator ruling: metric and telemetry names are part of the contract that all three SDKs share. 2. Deleted: every Go-only metric, category, span name, metric name and attribute key; no alias and no deprecation period. 3. Simplified or optimised: constants only; the store, the instrumentation helpers and the loggers keep their behaviour. 4. Accelerated: not applicable. 5. Automated: Go tests assert the full name sets against the values of the reference.

- **Standard metrics.** In `sdk-go/metrics/types.go`: the `MetricCategory` constants become the five categories of the reference; `StandardMetrics` becomes the 27 entries of `STANDARD_METRICS` with the name, category, description and unit of the reference, in its order.
- **Telemetry.** In `sdk-go/telemetry/conventions.go`: `SpanNames`, `MetricNames` and `AttributeKeys` hold one field per entry of `SPAN_NAMES`, `METRIC_NAMES` and `ATTRIBUTE_KEYS`, with the string values of the reference. Field names are the Go form of the reference keys (`PIPELINE_STAGE` becomes `PipelineStage`).
- **Callers.** Change every use of a removed field inside `sdk-go/` (for example in `sdk-go/metrics/instrumentation.go`, `sdk-go/telemetry/instrumentation.go`, `sdk-go/operator/`) to the reference name with the closest meaning. Where no reference name fits, use a string literal local to the caller and list the case in the PR body; do not add a name to the shared lists that the reference lacks.
- **Tests.** One test asserts that the set of standard metric names equals the 27 names of the reference; one each asserts the 7 span names, the 26 metric names and the 13 attribute keys. The expected values are written out in the test, with the reference file named in a comment.
- **Old-to-new table.** `sdk-go/README.md` gains a section "Migrating metric and telemetry names" with one table row per removed name: the old string, the new string, or "removed, no counterpart". Build the table from the diff, not from this task.
- **Release note.** The commit is `feat(sdk-go)!:` with a `BREAKING CHANGE:` footer that states the rename and points to the README section. Do not edit `sdk-go/CHANGELOG.md`; release-please writes it from the footer.
- **Parity exemptions.** If `conformance/parity/exemptions.json` exists on the base, remove the Go entries of the sections `standardMetrics`, `telemetrySpanNames`, `telemetryMetricNames` and `telemetryAttributeKeys`, and point the Go parity test at these definitions.
- **Stop rule.** If the count of entries in the reference differs from the counts in this task when the work starts, follow the reference and state the counts in the PR body.

Out of scope: the Python SDK; the compliance package; computing cost or tokens in Go; a new exporter; the `usage` module.

## Acceptance Criteria

- [ ] #1 The Go standard metric names equal the names of `STANDARD_METRICS` in `reference/src/metrics/types.ts`, each with the category and unit of the reference, and a test asserts the full name set.
- [ ] #2 The Go span names, metric names and attribute keys equal the values of `SPAN_NAMES`, `METRIC_NAMES` and `ATTRIBUTE_KEYS` in `reference/src/telemetry/semantic-conventions.ts`, and tests assert the three full sets.
- [ ] #3 No string that starts with `ai-sdlc.` remains in `sdk-go/telemetry/conventions.go`, and none of the four old metric categories remains in `sdk-go/metrics/types.go`.
- [ ] #4 `sdk-go/README.md` has the migration section with one row per removed name.
- [ ] #5 The commit subject starts with `feat(sdk-go)!:` and its body has a `BREAKING CHANGE:` footer; `sdk-go/CHANGELOG.md` is not in the diff.
- [ ] #6 The PR body lists every caller that got a local string literal, or states that there is none.
- [ ] #7 If `conformance/parity/exemptions.json` exists, it has no Go entry in the four metric and telemetry sections, and the Go parity test passes.
- [ ] #8 `go build ./... && go vet ./... && go test ./...` pass in `sdk-go/`, and `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
