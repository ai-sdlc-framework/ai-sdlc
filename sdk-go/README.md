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

## License

Apache-2.0
