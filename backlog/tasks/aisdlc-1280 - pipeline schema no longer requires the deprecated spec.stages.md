---
id: AISDLC-1280
title: 'Pipeline schema no longer requires the deprecated `spec.stages`'
status: In Progress
assignee: []
created_date: '2026-11-16'
labels:
  - spec
  - reference
  - sdk
  - adopter
dependencies: []
references:
  - spec/schemas/pipeline.schema.json
  - sdk-go/core/schemas/pipeline.schema.json
  - spec/spec.md
  - spec/rfcs/RFC-0056-composable-workflow-graph.md
  - reference/src/core/types.ts
  - reference/src/core/generated-schemas.ts
  - reference/src/reconciler/pipeline-reconciler.ts
  - sdk-go/core/types.go
  - sdk-go/conformance_test.go
  - sdk-python/src/ai_sdlc/core/types.py
  - sdk-python/src/ai_sdlc/core/_generated_schemas.py
  - sdk-python/src/ai_sdlc/reconciler/pipeline_reconciler.py
  - sdk-python/scripts/generate_schemas.py
  - sdk-python/tests/test_conformance.py
  - conformance/tests/v1alpha1/pipeline/invalid-missing-stages.yaml
  - conformance/tests/v1alpha1/pipeline/invalid-empty-stages.yaml
priority: medium
dispatchable: true
dispatchableReason: 'Adopter-reported (issue #2679), first of two tasks. Verified by the planner in source at main 1ffab4a1: `spec/schemas/pipeline.schema.json` marks `stages` `deprecated: true` and still lists it under `required`. RFC-0056 (Backward Compatibility) already decided the deprecation and later removal; this task opens no RFC question. The operator chose the full fix on 2026-11-16.'
---

## Description

**Gap (issue #2679).** RFC-0056 deprecates `pipeline.yaml spec.stages` "with a warn-on-use fallback for one release, then removed". PR #1958 added the warning and the `deprecated: true` flag, and left the field required:

- `spec/schemas/pipeline.schema.json`: `"required": ["triggers", "providers", "stages"]`, and `stages` has `minItems: 1`;
- `spec/spec.md` (Pipeline spec table): `stages` is `MUST`.

So no valid Pipeline document can avoid the deprecation warning: deleting the block fails validation with `/spec: must have required property 'stages'`. An adopter is warned about a field the schema forces them to write.

**Shape.** `stages` becomes optional in the schema, the normative text and every SDK. A Pipeline without `stages` validates and reconciles as a no-op. A Pipeline that sets `stages` is still accepted and still warned about. The scaffolded templates and the orchestrator readers are a separate task that follows this one.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: is `stages` still needed as a required field? No: RFC-0056 says pipeline-cli never executed it and the Workflow document replaces it. 2. Deleted: `stages` from `required`. 3. Simplified or optimised: `minItems: 1` stays for a document that does set the field, so `invalid-empty-stages.yaml` keeps its meaning and only one fixture changes. 4. Accelerated: n/a. 5. Automated: the conformance fixtures run in the TypeScript, Go and Python suites.

- `spec/schemas/pipeline.schema.json`: remove `stages` from `required`; keep `deprecated: true` and `minItems: 1`. Copy the result to `sdk-go/core/schemas/pipeline.schema.json`.
- Regenerate the inlined copies: `reference/src/core/generated-schemas.ts` (`pnpm --filter @ai-sdlc/reference generate-schemas`) and `sdk-python/src/ai_sdlc/core/_generated_schemas.py` (`sdk-python/scripts/generate_schemas.py`). The Python copy is already behind the spec (its `stages` description lacks the deprecation text); if regenerating changes other schemas, keep those changes and list them in the PR body.
- `spec/spec.md`: `stages` moves from `MUST` to `MAY`, with the deprecation note and a pointer to RFC-0056. Do not edit the RFC.
- Types: `stages` optional in `PipelineSpec` (`reference/src/core/types.ts`), `sdk-go/core/types.go` and `sdk-python/src/ai_sdlc/core/types.py`.
- Reconcilers: `reference/src/reconciler/pipeline-reconciler.ts` and `sdk-python/src/ai_sdlc/reconciler/pipeline_reconciler.py` treat an absent `stages` as an empty list (success, nothing to do). Check the Go reconciler for the same read.
- Conformance: `invalid-missing-stages.yaml` becomes a valid fixture (rename to `valid-no-stages.yaml` and fix its expectation). `invalid-empty-stages.yaml` stays invalid.
- Not in this task: the scaffold templates in `orchestrator/src/cli/commands/init.ts` and `pipeline-cli/src/config-manifest/manifest.ts`, and the readers in `orchestrator/src/execute.ts`, `fix-ci.ts` and `fix-review.ts`. Touch those readers only as far as the type change forces, and state in the PR body what was touched there.

## Acceptance Criteria

- [ ] #1 A Pipeline document with `triggers` and `providers` and no `stages` validates against `spec/schemas/pipeline.schema.json`; the conformance fixture for it is a valid fixture and passes in the TypeScript, Go and Python conformance suites.
- [ ] #2 A Pipeline document with `stages: []` is still invalid (`invalid-empty-stages.yaml` unchanged and passing as invalid).
- [ ] #3 A Pipeline document that sets `stages` validates as before, and loading it still logs the one deprecation warning.
- [ ] #4 `sdk-go/core/schemas/pipeline.schema.json` is byte-identical to `spec/schemas/pipeline.schema.json`, and both generated schema files match the output of their generators.
- [ ] #5 The reference and Python pipeline reconcilers return success for a Pipeline without `stages`; a test in each covers it.
- [ ] #6 `spec/spec.md` lists `stages` as `MAY` and deprecated.
- [ ] #7 The PR body references issue #2679 without a closing keyword (the scaffold task closes it).
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, and the Go and Python SDK test suites pass in CI.
