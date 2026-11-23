# AI-SDLC Go SDK

Go SDK for the [AI-SDLC Framework](https://ai-sdlc.io) — declarative governance for AI agents in software development lifecycles.

## Installation

```bash
go get github.com/ai-sdlc-framework/ai-sdlc/sdk-go
```

## Requirements

- Go 1.22+

## Quick Start

```go
package main

import (
    "fmt"
    aisdlc "github.com/ai-sdlc-framework/ai-sdlc/sdk-go"
    "github.com/ai-sdlc-framework/ai-sdlc/sdk-go/builders"
)

func main() {
    fmt.Println("AI-SDLC Go SDK version:", aisdlc.Version)

    // Build a pipeline resource
    pipeline, err := builders.NewPipelineBuilder("my-pipeline").
        AddTrigger("issue.assigned", nil).
        AddProvider("issueTracker", "linear", nil).
        AddStage("plan", "planner-agent", nil).
        Build()
    if err != nil {
        panic(err)
    }
    fmt.Println("Pipeline:", pipeline.Metadata.Name)
}
```

## Modules

| Package | Description |
|---------|-------------|
| `core` | Resource types, validation, comparison, provenance |
| `builders` | Fluent builders for all 5 resource types |
| `policy` | Enforcement, autonomy, complexity, authorization |
| `adapters` | Adapter interfaces, registry, event bus |
| `agents` | Orchestration, discovery, memory |
| `reconciler` | Reconciliation loop and diff engine |
| `telemetry` | OpenTelemetry conventions and instrumentation |
| `audit` | Audit logging with hash-chained entries |
| `security` | Sandbox, JIT credentials, kill switch, approvals |
| `compliance` | Regulatory framework compliance checking |
| `metrics` | Metric store and instrumentation helpers |

## Migration: compliance package

The `compliance` package now uses the control model of the reference (`reference/src/compliance`) so coverage figures match the TypeScript and Python SDKs.

- Removed: the per-framework feature-list model, including its result type and the feature-name field. Framework-side control ids from that model are gone.
- Added: `AISDLCControls` (10 controls), `MappingsForFramework`, and `AllControlIDs`.
- `CheckCompliance(enabledControls map[string]bool, framework Framework)` now takes enabled AI-SDLC control ids (for example `quality-gates`), not feature names, and the argument order is swapped. `CheckAllFrameworks` takes the same set.
- `ComplianceCoverageReport` now has `CoveredControls`, `Gaps` (the uncovered mappings) and `CoveragePercent` (0 to 100) in place of `CoveredCount`, `Controls` and `Coverage` (0 to 1).
- To enable everything, pass `compliance.AllControlIDs()`.

## Migration: reference-aligned metric and telemetry names

The `metrics` and `telemetry` packages now define exactly the names in `reference/src/metrics/types.ts` and `reference/src/telemetry/semantic-conventions.ts`. Names that only Go had are removed.

| Removed name | Replacement |
|---|---|
| `ai-sdlc.evaluate_gate` | `ai_sdlc.gate.evaluation` |
| `ai-sdlc.enforce` | (removed) |
| `ai-sdlc.reconcile` | `ai_sdlc.reconciliation.cycle` |
| `ai-sdlc.execute_step` | `ai_sdlc.pipeline.stage` |
| `ai-sdlc.orchestrate` | `ai_sdlc.pipeline.run` |
| `ai-sdlc.promote` | (removed) |
| `ai-sdlc.demote` | (removed) |
| `ai-sdlc.admit_resource` | (removed) |
| `ai-sdlc.score_complexity` | (removed) |
| `ai-sdlc.route_by_complexity` | (removed) |
| `ai_sdlc.gate.evaluations` | (removed) |
| `ai_sdlc.gate.passed` | `ai_sdlc.gate.pass.total` |
| `ai_sdlc.gate.failed` | `ai_sdlc.gate.fail.total` |
| `ai_sdlc.reconcile.loops` | (removed) |
| `ai_sdlc.reconcile.errors` | (removed) |
| `ai_sdlc.steps.executed` | `ai_sdlc.task.success.total` |
| `ai_sdlc.steps.failed` | `ai_sdlc.task.failure.total` |
| `ai_sdlc.autonomy.promotion_attempts` | `ai_sdlc.autonomy.promotion.total` |
| `ai_sdlc.autonomy.demotion_attempts` | `ai_sdlc.autonomy.demotion.total` |
| `ai_sdlc.gate.name` | `ai_sdlc.gate` |
| `ai_sdlc.gate.enforcement` | `ai_sdlc.enforcement` |
| `ai_sdlc.pipeline.name` | `ai_sdlc.pipeline` |
| `ai_sdlc.stage.name` | `ai_sdlc.stage` |
| `ai_sdlc.agent.name` | `ai_sdlc.agent` |
| `ai_sdlc.step.type` | (removed) |
| `ai_sdlc.autonomy.level (attribute)` | (removed; `ai_sdlc.autonomy.level` is now a metric name only) |
| `ai_sdlc.autonomy.from_level` | (removed) |
| `ai_sdlc.autonomy.to_level` | (removed) |
| `coverage` | `test-coverage` |
| `approval-rate (category `quality`)` | approval-rate (category `human-in-loop`, unit `percent`) |
| `defect-rate` | (removed) |
| `mean-time-to-resolve` | `mean-time-to-completion` |
| `deployment-frequency` | (removed) |
| `lead-time` | (removed) |
| `vulnerability-count` | `security-finding-rate` |
| `secret-exposure-count` | (removed) |
| `compliance-coverage (category `compliance`, unit `ratio`)` | compliance-coverage (category `code-quality`, unit `percent`) |
| `audit-completeness` | (removed) |
| `category `quality`/`performance`/`security`/`compliance` and constants `CategoryQuality`, `CategoryPerformance`, `CategorySecurity`, `CategoryCompliance`` | `task-effectiveness`, `human-in-loop`, `code-quality`, `economic-efficiency`, `autonomy-trajectory` |
| ``SpanNames`/`MetricNames`/`AttributeKeys` Go field names` | renamed to the reference constant names (e.g. `SpanNames.GateEvaluation`) |

## License

Apache-2.0

## Scope

This SDK carries the eleven `shared` reference modules: `adapters`, `agents`, `audit`, `builders`, `compliance`, `core`, `metrics`, `policy`, `reconciler`, `security` and `telemetry`. The reference modules `capabilities`, `judgment`, `models`, `usage` and `utils` are `typescript-only` and are not part of this SDK. The classification lives in `conformance/parity/scope.json` and `pnpm parity:check` enforces it.
