# AI-SDLC Conformance Tests

Language-agnostic conformance test suite for AI-SDLC Framework implementations.

## Structure

```
tests/v1alpha1/
  pipeline/          — Pipeline resource test fixtures
  quality-gate/      — QualityGate resource test fixtures
  autonomy-policy/   — AutonomyPolicy resource test fixtures
  adapter/           — AdapterBinding resource test fixtures
```

## Fixture Naming

- `valid-*.yaml` — documents that MUST be accepted by a conformant implementation
- `invalid-*.yaml` — documents that MUST be rejected by a conformant implementation

## Conformance Levels

| Level | Required Fixtures |
| --- | --- |
| Core | `pipeline/valid-*`, `quality-gate/valid-*`, all `invalid-*` |
| Adapter | Core + `adapter/valid-*` |
| Full | Adapter + `autonomy-policy/valid-*` + reconciliation behavior tests |

## Runner

The `runner/` package provides a TypeScript-based conformance runner. See the [runner README](runner/) for usage.

## License

Apache-2.0
