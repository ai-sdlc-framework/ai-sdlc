# @ai-sdlc/reference

TypeScript reference implementation of the [AI-SDLC Framework](../spec/spec.md).

## Status

**v0.1.0 — Early Development**

This package provides the canonical implementation of the AI-SDLC specification, including:

- TypeScript types derived from the JSON Schema definitions
- Schema validation using ajv
- Adapter interface contracts
- Policy enforcement engine
- Reconciliation loop primitives
- Agent orchestration patterns

## Installation

```bash
pnpm add @ai-sdlc/reference
```

## Usage

```typescript
import { validate, type Pipeline } from '@ai-sdlc/reference';

const result = validate('Pipeline', pipelineDocument);
if (result.valid) {
  const pipeline: Pipeline = result.data;
}
```

## Structure

```
src/
  core/        — Types, schema validation
  adapters/    — Interface contracts for tool integrations
  policy/      — Quality gate enforcement engine
  reconciler/  — Reconciliation loop primitives
  agents/      — Orchestration patterns
```

## License

Apache-2.0
