# AI-SDLC Conformance Tests

Language-agnostic conformance test suite for AI-SDLC Framework implementations.

## Structure

```
tests/v1alpha1/
  pipeline/          — Pipeline resource test fixtures
  quality-gate/      — QualityGate resource test fixtures
  autonomy-policy/   — AutonomyPolicy resource test fixtures
  adapter/           — AdapterBinding resource test fixtures

audit-chain/         — Cross-SDK audit hash chain fixture (fixture.json) and
                       per-SDK sample chains (samples/*.jsonl); see spec.md#audit-entry.
                       Regenerate a sample with AUDIT_CONFORMANCE_WRITE=1 in that SDK's test.
```

## Parity manifest

`parity/manifest.json` lists the named surface of the TypeScript reference in seven sorted sections: `resourceKinds`, `standardMetrics`, `spanNames`, `metricNames`, `attributeKeys`, `complianceControls`, `regulatoryFrameworks`. It is generated from `reference/src/` and `pnpm parity:check` (part of `pnpm test`) fails when it is out of date. Regenerate it with:

```
node scripts/generate-parity-manifest.mjs
```

The Python suite (`sdk-python/tests/test_parity.py`) and the Go suite (`sdk-go/parity_test.go`) check that every manifest name appears in the SDK's own source, or is exempt.

The check runs in both directions:

- Manifest to SDK: every manifest name must appear in the SDK's mapped source file, or be exempt.
- SDK to manifest: in each section, the set of names the SDK defines must be a subset of the manifest. A name the SDK defines and the reference lacks (for example a Go-only metric name, telemetry name or compliance control id) fails that SDK's suite. There is no exemption list for this direction. Both suites keep a test that adds a name to a patched copy of the source and asserts it is reported.

`parity/exemptions.json` (`{ "python" | "go": { section: [names] } }`) records what an SDK lacks today. It can only shrink: `pnpm parity:check` fails when it gains an entry the base ref does not have, and an SDK test fails when an exempt name becomes defined (remove the entry then).

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

## Module scope

`parity/scope.json` names every directory of `reference/src/` with a class and a reason. `shared` means each SDK carries the module: `sdk-typescript/package.json` exports it, `sdk-python/src/ai_sdlc/` has a package and `sdk-go/` has a directory of that name. `typescript-only` means only the reference carries it. `pnpm parity:check` fails when a directory has no entry, an entry has no directory, a class is unknown, a reason is missing, or a `shared` module lacks a counterpart. The shared modules are `adapters`, `agents`, `audit`, `builders`, `compliance`, `core`, `metrics`, `policy`, `reconciler`, `security` and `telemetry`; `capabilities`, `judgment`, `models`, `usage` and `utils` are `typescript-only`.
