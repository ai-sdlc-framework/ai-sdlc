# API Reference

Detailed reference for all AI-SDLC resource types and schemas.

## Resource Types

| Kind | Schema | Spec |
| --- | --- | --- |
| Pipeline | [pipeline.schema.json](../../spec/schemas/pipeline.schema.json) | [spec.md#5.1](../../spec/spec.md#51-pipeline) |
| AgentRole | [agent-role.schema.json](../../spec/schemas/agent-role.schema.json) | [spec.md#5.2](../../spec/spec.md#52-agentrole) |
| QualityGate | [quality-gate.schema.json](../../spec/schemas/quality-gate.schema.json) | [spec.md#5.3](../../spec/spec.md#53-qualitygate) |
| AutonomyPolicy | [autonomy-policy.schema.json](../../spec/schemas/autonomy-policy.schema.json) | [spec.md#5.4](../../spec/spec.md#54-autonomypolicy) |
| AdapterBinding | [adapter-binding.schema.json](../../spec/schemas/adapter-binding.schema.json) | [spec.md#5.5](../../spec/spec.md#55-adapterbinding) |

## Common Definitions

Shared types (metadata, conditions, secretRef, duration) are defined in [common.schema.json](../../spec/schemas/common.schema.json).

## Adapter Interfaces

See [adapters.md](../../spec/adapters.md#2-interface-contracts) for the six interface contracts.
