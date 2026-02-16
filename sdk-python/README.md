# ai-sdlc

Python SDK for the [AI-SDLC Framework](https://ai-sdlc.io) — a Kubernetes-style declarative framework for governing AI agents in software development lifecycles.

## Installation

```bash
pip install ai-sdlc
```

## Quick Start

```python
from ai_sdlc.core.types import Pipeline, API_VERSION
from ai_sdlc.core.validation import validate_resource
from ai_sdlc.builders.builders import PipelineBuilder

# Build a pipeline using the fluent API
pipeline = (
    PipelineBuilder("my-pipeline")
    .add_trigger({"event": "issue.assigned"})
    .add_provider("github", {"type": "github"})
    .add_stage({"name": "implement"})
    .build()
)

# Validate against JSON Schema
result = validate_resource(pipeline.model_dump(by_alias=True))
assert result.valid
```

## Modules

| Module | Description |
|--------|------------|
| `core` | Pydantic models for all 5 resource types, JSON Schema validation, comparison, provenance |
| `builders` | Fluent builder classes for resource construction |
| `policy` | Enforcement engine, autonomy evaluation, complexity routing, authorization |
| `adapters` | Interface Protocols, adapter registry, community stubs |
| `reconciler` | asyncio-based reconciliation loop with domain reconcilers |
| `agents` | Orchestration patterns, executor, multi-tier memory |
| `security` | Sandbox, JIT credentials, kill switch, approval workflow Protocols |
| `telemetry` | OpenTelemetry semantic conventions, structured logging |
| `compliance` | Regulatory framework mappings (EU AI Act, NIST AI RMF, ISO 42001, etc.) |
| `metrics` | Metric store, standard metric definitions |
| `audit` | JSONL audit logging with tamper-evident hashing |

## Requirements

- Python 3.11+
- pydantic >= 2.0
- jsonschema >= 4.20
- PyYAML >= 6.0
- opentelemetry-api >= 1.20

## License

Apache-2.0
