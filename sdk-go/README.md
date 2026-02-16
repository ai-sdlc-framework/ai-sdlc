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

## License

Apache-2.0
