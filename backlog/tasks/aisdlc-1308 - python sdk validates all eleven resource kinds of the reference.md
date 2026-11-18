---
id: AISDLC-1308
title: 'Python SDK validates all eleven resource kinds of the reference'
status: To Do
assignee: []
created_date: '2026-11-17'
labels:
  - sdk-python
  - sdk-parity
  - conformance
dependencies:
  - AISDLC-1302
  - AISDLC-1305
references:
  - reference/src/core/types.ts
  - reference/src/core/validation.ts
  - spec/schemas/design-system-binding.schema.json
  - spec/schemas/design-intent-document.schema.json
  - spec/schemas/journey.v1.schema.json
  - spec/schemas/dor-config.v1.schema.json
  - spec/schemas/compliance-posture.v1.schema.json
  - spec/schemas/judgment-config.v1.schema.json
  - spec/schemas/capabilities-config.v1.schema.json
  - sdk-python/src/ai_sdlc/core/types.py
  - sdk-python/src/ai_sdlc/core/validation.py
  - sdk-python/src/ai_sdlc/core/_generated_schemas.py
  - sdk-python/scripts/generate_schemas.py
  - sdk-python/tests/test_conformance.py
  - conformance/tests/v1alpha1
priority: medium
dispatchable: true
dispatchableReason: 'Operator order of 2026-11-17: "draft 1, 2 and 4 and file them" (item 1: shrink the parity exemption list for resource kinds). Operator ruling of the same day: resource kinds and schemas match in all three SDKs; the engines of judgment, usage, capabilities and design-system stay TypeScript-only. The survey read the files: the reference has 11 kinds, the Python SDK 5.'
---

## Description

**Gap.** `ResourceKind` in `reference/src/core/types.ts` has 11 members and `SCHEMA_FILES` in `reference/src/core/validation.ts` maps each to a schema. The Python SDK knows 5 (`Pipeline`, `AgentRole`, `QualityGate`, `AutonomyPolicy`, `AdapterBinding`): `validate_resource` in `sdk-python/src/ai_sdlc/core/validation.py` refuses a document of kind `DesignSystemBinding`, `DesignIntentDocument`, `DorConfig`, `CompliancePosture`, `JudgmentConfig` or `CapabilitiesConfig` as unknown. No conformance fixture exists for these six kinds, so no SDK is tested on them.

**Shape.** The Python SDK accepts and refuses documents of all 11 kinds exactly as the schema in `spec/schemas/` says, and shared conformance fixtures prove it for the six new kinds. The SDK gains no engine for them.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must an SDK validate a kind whose engine stays TypeScript-only? Yes, by the operator ruling: a resource document is part of the shared contract; a Python tool that reads a repository's configuration must not refuse a valid file. 2. Deleted: typed models, builders and any behaviour for the six kinds are not written. 3. Simplified or optimised: the six kinds use the schema-sync mechanism that AISDLC-1302 established (explicit schema list, equality test). 4. Accelerated: not applicable. 5. Automated: conformance fixtures and the parity exemption list.

- **Kinds.** Add the six names to the `ResourceKind` literal in `sdk-python/src/ai_sdlc/core/types.py`, in the order of the reference.
- **Schemas.** Add the six schema files named in `references`, plus `journey.v1.schema.json` (referenced by the design intent schema), to the explicit list of `sdk-python/scripts/generate_schemas.py` and regenerate `_generated_schemas.py`. Extend the equality test of AISDLC-1302 to the new entries.
- **Validation.** Add the six kinds to `SCHEMA_FILES` in `sdk-python/src/ai_sdlc/core/validation.py` with the file names that `SCHEMA_FILES` of the reference uses. Cross-schema `$ref` resolution must work for the design intent schema.
- **Result type.** `validate_resource` returns for the six kinds what it returns today for a valid document whose kind has no typed model need; do not add pydantic models. If the function cannot return a result without a typed model, return the validated mapping and state the choice in the PR body.
- **Fixtures.** Under `conformance/tests/v1alpha1/` add one directory per new kind, named as the existing ones are (kebab case of the kind), each with one valid and one invalid fixture in the format of the existing fixtures. Take the valid document from an example in the schema or in `reference/` tests; the invalid one omits one required field.
- **Parity exemptions.** Remove the six kinds from the `python` list of the `resourceKinds` section of `conformance/parity/exemptions.json`.
- **Stop rule.** If a new fixture makes the conformance run of the reference or of the Go SDK fail, do not change `reference/`, `spec/schemas/` or `sdk-go/`; remove nothing, report the failing runner and the message in the verdict notes and stop.

Out of scope: typed models and builders for the six kinds; the Go SDK; any engine of judgment, capabilities, compliance posture, Definition of Ready or design system; changes to `spec/schemas/`.

## Acceptance Criteria

- [ ] #1 The `ResourceKind` literal of the Python SDK has the 11 members of `ResourceKind` in `reference/src/core/types.ts`.
- [ ] #2 `validate_resource` accepts the valid fixture and refuses the invalid fixture of each of the six new kinds, and a test asserts both per kind.
- [ ] #3 Each new schema entry in `_generated_schemas.py` equals the file in `spec/schemas/`, a test asserts it, and `python sdk-python/scripts/generate_schemas.py` on the merged tree leaves no diff.
- [ ] #4 `conformance/tests/v1alpha1/` has a directory with one valid and one invalid fixture for each of the six kinds, and `sdk-python/tests/test_conformance.py` runs them.
- [ ] #5 `conformance/parity/exemptions.json` has no entry in `python` / `resourceKinds`, and the Python parity test passes.
- [ ] #6 No pydantic model, builder or file under `reference/`, `spec/schemas/` or `sdk-go/` was added or changed.
- [ ] #7 The Python suite, the conformance run of the reference and the Go suite pass, and `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
