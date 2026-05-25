# Examples

Complete working examples demonstrating AI-SDLC SDK usage.

## TypeScript Examples

| Example | Description |
|---|---|
| [builder-examples.ts](builder-examples.ts) | All 5 resource builders with validation |
| [gate-enforcement.ts](gate-enforcement.ts) | Programmatic quality gate evaluation with override and failure scenarios |
| [adapter-implementation.ts](adapter-implementation.ts) | Custom adapter from scratch, registry, webhook bridge, EventBus (RFC-0003 §3 example — IssueTracker pattern extended to the five infrastructure interfaces) |
| [orchestration-patterns.ts](orchestration-patterns.ts) | All 5 orchestration patterns with execution and handoff validation |

## Translator Examples (BYO upstream for the spec-kit bridge)

See [`docs/concepts/adopter-translators.md`](../concepts/adopter-translators.md) for the full BYO translator pattern (RFC-0036 Phase 10 / OQ-6).

| Example | Description |
|---|---|
| [translators/example-adopter.ts](translators/example-adopter.ts) | Typed translator scaffold with `// TODO:` markers; copy + adapt for any upstream |
| [translators/linear-translator.ts](translators/linear-translator.ts) | Worked example: Linear issues → spec-kit `tasks.md` via GraphQL |

## YAML Examples

| Example | Description |
|---|---|
| [complete-pipeline.yaml](complete-pipeline.yaml) | Full pipeline with all resource types configured together (RFC-0002 §6 example) |

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
