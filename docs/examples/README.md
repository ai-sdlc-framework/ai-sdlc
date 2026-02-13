# Examples

Complete working examples demonstrating AI-SDLC SDK usage.

## TypeScript Examples

| Example | Description |
|---|---|
| [builder-examples.ts](builder-examples.ts) | All 5 resource builders with validation |
| [gate-enforcement.ts](gate-enforcement.ts) | Programmatic quality gate evaluation with override and failure scenarios |
| [adapter-implementation.ts](adapter-implementation.ts) | Custom adapter from scratch, registry, webhook bridge, EventBus |
| [orchestration-patterns.ts](orchestration-patterns.ts) | All 5 orchestration patterns with execution and handoff validation |

## YAML Examples

| Example | Description |
|---|---|
| [complete-pipeline.yaml](complete-pipeline.yaml) | Full pipeline with all resource types configured together |

## Running Examples

The TypeScript examples can be run directly:

```bash
npx tsx docs/examples/builder-examples.ts
npx tsx docs/examples/gate-enforcement.ts
npx tsx docs/examples/adapter-implementation.ts
npx tsx docs/examples/orchestration-patterns.ts
```

## Type Checking

Verify examples compile without errors:

```bash
cd docs/examples
npx tsc --noEmit
```

Or validate YAML examples against the schemas:

```bash
pnpm --filter @ai-sdlc/reference validate-schemas
```
