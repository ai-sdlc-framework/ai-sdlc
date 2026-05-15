# Loader-private YAMLs and Adopter-Extension Kinds

## Problem

The AI-SDLC schema validator (`validateResource` in `@ai-sdlc/reference`) only knows about the
canonical resource kinds it ships with — `Pipeline`, `AgentRole`, `QualityGate`, etc.  When an
adopter's config directory contains YAML files for loader-private helpers (e.g.
`maintainers.yaml`, `soul-tracks.yaml`) that carry a `kind:` field, earlier versions of the
validator emitted a false-positive `Unknown resource kind: MaintainersList` warning on every
pipeline run.

## Decision (AISDLC-265): wrapper-less convention + graceful skip

Two options were evaluated:

| Option | Description | Tradeoff |
|---|---|---|
| 1 — Extension registry | Register adopter kinds in the canonical schema registry | Requires versioning and schema governance for adopter-specific schemas; too heavyweight for private helpers |
| 2 — Wrapper-less convention + graceful skip | Declare that loader-private files should omit `apiVersion`/`kind`; validator silently skips unknown kinds | Simple, zero-config, forward-compatible |

**Option 2 was chosen.** It matches the Forge S189 handoff convention already in use.

The validator now returns `{ valid: true, skipped: true }` when it encounters a `kind` value
that is not in the AI-SDLC schema registry.  Callers (including `validateConfigFiles` in the
orchestrator and the `config.ts` admission loader) silently drop skipped files so no warning is
emitted.

## Recommended pattern for loader-private YAML files

Loader-private YAML files (read by adopter PPA wrappers, not by AI-SDLC infrastructure) should
**omit the `apiVersion` and `kind` envelope** entirely:

```yaml
# .ai-sdlc/maintainers.yaml — no apiVersion/kind header
maintainers:
  - alice
  - bob
```

```yaml
# .ai-sdlc/soul-tracks.yaml — no apiVersion/kind header
tracks:
  track:enchantment: 0.85
  track:reflect: 0.85
```

Without an `apiVersion` field, `config.ts` skips the file before it even reaches the validator
(the check at line ~116: documents must have both `apiVersion` and `kind` to be candidate
resources).

## What if I need a kind envelope on a loader-private file?

If your loader-private file does carry `apiVersion: ai-sdlc/v1` and a custom `kind:`, the
validator now handles this gracefully — it returns `{ valid: true, skipped: true }` and the
file is silently excluded from validation results.  You will NOT see a warning.

This is the fallback for:
- Legacy adopter files that already have a `kind:` header.
- Adopter kinds that happen to use the `ai-sdlc/v1` API group but are not part of the canonical
  registry.

## Canonical resource kinds (validated by AI-SDLC)

The following `kind` values are in the schema registry and ARE validated:

| Kind | Schema |
|---|---|
| `Pipeline` | `pipeline.schema.json` |
| `AgentRole` | `agent-role.schema.json` |
| `QualityGate` | `quality-gate.schema.json` |
| `AutonomyPolicy` | `autonomy-policy.schema.json` |
| `AdapterBinding` | `adapter-binding.schema.json` |
| `DesignSystemBinding` | `design-system-binding.schema.json` |
| `DesignIntentDocument` | `design-intent-document.schema.json` |
| `DorConfig` | `dor-config.v1.schema.json` |

Any other `kind` value is treated as a loader-private or adopter-extension kind and is skipped.

## API reference

`ValidationResult` (exported from `@ai-sdlc/reference`) now includes a `skipped` flag:

```typescript
interface ValidationResult<T = AnyResource> {
  valid: boolean;
  data?: T;
  errors?: ValidationError[];
  /** True when the document's kind is not in the AI-SDLC schema registry. */
  skipped?: boolean;
}
```

When `skipped` is `true`, `valid` is also `true` and `errors` is `undefined`.

## Adopter consumption pattern

If you build a custom PPA wrapper that reads loader-private YAML files, use the wrapper-less
convention (no `apiVersion`/`kind`) or handle `result.skipped` in your validation loop:

```typescript
import { validateResource } from '@ai-sdlc/reference';

const result = validateResource(doc);
if (result.skipped) {
  // Loader-private or adopter-extension kind — safe to ignore
  return;
}
if (!result.valid) {
  // Genuine schema violation — surface as a real error
  console.error(result.errors);
}
```
